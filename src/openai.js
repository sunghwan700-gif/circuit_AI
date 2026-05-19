/**
 * AI 프록시 사용 가능 여부.
 * - 로컬: Vite dev 서버가 /api/openai/chat 을 처리합니다.
 * - Netlify: Function (스트리밍·heartbeat) 또는 Background + 폴링(Pro)
 */
export function isOpenAiProxyAvailable() {
  return true
}

function getChatApiUrl() {
  return '/api/openai/chat'
}

function getChatJobApiUrl() {
  return '/api/openai/chat/job'
}

/** 로컬은 Vite가 POST 시 바로 처리. 배포만 Background Function 호출 */
function getBackgroundTriggerUrl() {
  if (import.meta.env.DEV && import.meta.env.VITE_NETLIFY_DEPLOY !== 'true') {
    return ''
  }
  return '/api/openai/chat/background'
}

async function triggerBackgroundWorker(jobId, requestBody) {
  const url = getBackgroundTriggerUrl()
  if (!url) return

  const payload = JSON.stringify({ jobId, request: requestBody })
  const post = () =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: payload,
    })

  try {
    const r = await post()
    if (r.status === 202 || r.ok) return
  } catch {
    /* retry */
  }
  await sleep(600)
  try {
    await post()
  } catch {
    /* poll 단계에서 pending 지속 시 재시도 */
  }
}

function shouldFallbackFromBackground(err) {
  const msg = err instanceof Error ? err.message : String(err || '')
  return /일시적으로 응답|502|503|504|작업을 시작|작업 ID|연결하지 못|Background trigger/i.test(
    msg,
  )
}

/** Pro 채팅: Netlify Background(배포) 또는 로컬 job API로 26초 한도 우회 */
export function useAiChatBackground() {
  if (import.meta.env.VITE_AI_CHAT_BACKGROUND === 'false') return false
  const m = String(
    import.meta.env.VITE_GEMINI_CHAT_MODEL ||
      import.meta.env.VITE_GEMINI_MODEL ||
      '',
  ).toLowerCase()
  const wantsPro = /pro/.test(m)
  if (import.meta.env.VITE_AI_CHAT_BACKGROUND === 'true') {
    return wantsPro || import.meta.env.PROD === true
  }
  const deploy =
    import.meta.env.VITE_NETLIFY_DEPLOY === 'true' || import.meta.env.PROD === true
  return deploy && wantsPro
}

/**
 * @param {string} raw
 * @param {number} status
 */
/** @param {unknown} err */
export function normalizeChatFetchError(err) {
  const msg = err instanceof Error ? err.message : String(err || '')
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return '서버에 연결하지 못했습니다. npm run dev 가 실행 중인지 확인한 뒤 새로고침 후 다시 시도해 주세요.'
  }
  if (/no longer available|flash-lite/i.test(msg)) {
    return 'AI 모델 설정을 업데이트 중입니다. 잠시 후 다시 시도해 주세요.'
  }
  return msg
}

function parseApiError(raw, status) {
  const text = String(raw || '').trim()
  if (!text) return `요청 실패 (${status})`

  if (/no longer available|flash-lite|invalid model/i.test(text)) {
    return 'AI 모델 연결에 문제가 있습니다. 잠시 후 다시 시도해 주세요.'
  }

  if (
    /^\s*</.test(text) ||
    /<TITLE>\s*Inactivity Timeout\s*<\/TITLE>/i.test(text) ||
    /Inactivity Timeout/i.test(text) ||
    /Too much time has passed without sending any data/i.test(text)
  ) {
    return '서버 응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.'
  }

  if (
    /timed?\s*out|execution timed out|function invocation|deadline exceeded/i.test(
      text,
    )
  ) {
    return '서버 응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.'
  }

  try {
    const j = JSON.parse(text)
    const detail = j.error?.message || j.error
    if (typeof detail === 'string' && detail.trim()) return detail.trim()
  } catch {
    /* ignore */
  }

  if (status === 504 || status === 502 || status === 503) {
    return 'AI 서버가 일시적으로 응답하지 않습니다. 잠시 후 다시 시도해 주세요.'
  }

  if (text.length > 280) {
    return `요청 실패 (${status}). 잠시 후 다시 시도해 주세요.`
  }
  return text
}

/** @param {string} msg */
function isRetryableErrorMessage(msg) {
  return /일시적|502|503|504|과부하|빈 응답|답변을 만들지 못했습니다/i.test(msg)
}

function getChatClientTimeoutMs() {
  const deploy =
    import.meta.env.VITE_NETLIFY_DEPLOY === 'true' || import.meta.env.PROD === true
  return deploy ? 90_000 : 180_000
}

function getBackgroundPollDeadlineMs() {
  return 180_000
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * @param {ReadableStream<Uint8Array>} body
 * @param {(ev: { event: string, text?: string, message?: string, model?: string }) => void} onEvent
 */
async function consumeNdjsonStream(body, onEvent) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      const t = line.trim()
      if (!t) continue
      try {
        onEvent(JSON.parse(t))
      } catch {
        /* ignore partial */
      }
    }
  }
  const tail = buf.trim()
  if (tail) {
    try {
      onEvent(JSON.parse(tail))
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {object} body
 * @param {{ onStatus?: (msg: string) => void }=} options
 */
async function sendOpenAiChatViaBackgroundJob(body, options) {
  const bodyJson = JSON.stringify(body)
  if (bodyJson.length > 5_200_000) {
    throw new Error(
      '이미지·대화 내용이 서버 한도를 넘었습니다. 사진 수를 줄여 다시 질문해 주세요.',
    )
  }

  const startRes = await fetch(getChatJobApiUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: bodyJson,
  })

  const startRaw = await startRes.text()
  if (!startRes.ok && startRes.status !== 202) {
    throw new Error(parseApiError(startRaw, startRes.status))
  }

  let jobId = ''
  try {
    const j = JSON.parse(startRaw)
    jobId = String(j.jobId || '').trim()
  } catch {
    throw new Error('작업을 시작하지 못했습니다.')
  }
  if (!jobId) throw new Error('작업 ID를 받지 못했습니다.')

  await triggerBackgroundWorker(jobId, body)

  options?.onStatus?.('Pro 모델로 분석 중입니다. 30초~2분 걸릴 수 있습니다…')

  const deadline = Date.now() + getBackgroundPollDeadlineMs()
  let polls = 0
  let pollErrors = 0
  let lastPendingAt = Date.now()
  while (Date.now() < deadline) {
    await sleep(polls < 3 ? 1500 : 2500)
    polls += 1

    let stRes
    let stRaw = ''
    try {
      stRes = await fetch(
        `${getChatJobApiUrl()}?jobId=${encodeURIComponent(jobId)}`,
        { headers: { Accept: 'application/json' } },
      )
      stRaw = await stRes.text()
    } catch {
      pollErrors += 1
      if (pollErrors < 10) continue
      throw new Error('분석 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.')
    }

    if (!stRes.ok) {
      if (
        (stRes.status === 502 || stRes.status === 503 || stRes.status === 504) &&
        pollErrors < 12
      ) {
        pollErrors += 1
        continue
      }
      if (stRes.status === 404) throw new Error('분석 작업을 찾을 수 없습니다.')
      throw new Error(parseApiError(stRaw, stRes.status))
    }
    pollErrors = 0

    let job
    try {
      job = JSON.parse(stRaw)
    } catch {
      continue
    }

    const status = String(job.status || '')
    const msg = String(job.message || '')

    if (status === 'pending' || status === 'running') {
      if (status === 'pending' && Date.now() - lastPendingAt > 12_000) {
        lastPendingAt = Date.now()
        await triggerBackgroundWorker(jobId, body)
      }
      options?.onStatus?.(
        msg || 'Pro 모델로 분석 중입니다. 잠시만 기다려 주세요…',
      )
      continue
    }

    if (status === 'done') {
      const text = String(job.text || '').trim()
      if (!text) {
        throw new Error('AI가 답변을 만들지 못했습니다.')
      }
      if (job.model && options?.onStatus) {
        options.onStatus(
          /pro/i.test(String(job.model))
            ? 'Pro 분석 완료'
            : '답변 완료',
        )
      }
      return text
    }

    if (status === 'error') {
      throw new Error(msg || 'AI 분석에 실패했습니다.')
    }
  }

  throw new Error(
    'Pro 분석 시간이 초과되었습니다. 사진을 줄이고 같은 질문을 다시 보내 주세요.',
  )
}

/**
 * @param {{ role: string, content: string }[]} messages
 * @param {string} contextDescription
 * @param {{ dataUrl: string, label?: string }[]=} images
 * @param {{ skipRefine?: boolean, onStatus?: (msg: string) => void, practiceContext?: string, chatGuidance?: string, hasImages?: boolean }=} options
 */
async function sendOpenAiChatStreaming(
  messages,
  contextDescription,
  images,
  options,
) {
  const body = {
    messages,
    contextDescription,
    images,
    skipRefine: true,
    stream: true,
    practiceContext: options?.practiceContext,
    chatGuidance: options?.chatGuidance,
    hasImages: options?.hasImages,
  }

  const bodyJson = JSON.stringify(body)
  if (bodyJson.length > 5_200_000) {
    throw new Error(
      '이미지·대화 내용이 서버 한도를 넘었습니다. 사진 수를 줄여 다시 질문해 주세요.',
    )
  }

  const res = await fetch(getChatApiUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/x-ndjson',
    },
    body: bodyJson,
    signal: AbortSignal.timeout(getChatClientTimeoutMs()),
  })

  if (!res.ok) {
    const raw = await res.text()
    throw new Error(parseApiError(raw, res.status))
  }

  const ctype = res.headers.get('content-type') || ''
  if (!ctype.includes('ndjson') || !res.body) {
    const raw = await res.text()
    let data
    try {
      data = JSON.parse(raw)
    } catch {
      throw new Error(parseApiError(raw, res.status))
    }
    const text = data.choices?.[0]?.message?.content?.trim()
    if (!text) throw new Error('모델 응답이 비어 있습니다.')
    return text
  }

  let resultText = ''
  await consumeNdjsonStream(res.body, (ev) => {
    if (ev.event === 'status' && ev.message && options?.onStatus) {
      options.onStatus(String(ev.message))
    }
    if (ev.event === 'error' && ev.message) {
      throw new Error(String(ev.message))
    }
    if (ev.event === 'done' && ev.text) {
      resultText = String(ev.text)
      if (ev.model && options?.onStatus) {
        options.onStatus(
          /pro/i.test(String(ev.model))
            ? 'Pro 분석 완료'
            : '답변 완료 (안정 모드)',
        )
      }
    }
  })

  if (!resultText.trim()) {
    throw new Error(
      'AI가 답변을 만들지 못했습니다. 잠시 후 같은 질문을 다시 보내 주세요.',
    )
  }
  return resultText.trim()
}

/**
 * @param {{ role: string, content: string }[]} messages
 * @param {string} contextDescription
 * @param {{ dataUrl: string, label?: string }[]=} images
 * @param {{ skipRefine?: boolean, maxAttempts?: number, onStatus?: (msg: string) => void, practiceContext?: string, chatGuidance?: string, hasImages?: boolean }=} options
 */
export async function sendOpenAiChat(messages, contextDescription, images, options) {
  const deploy =
    import.meta.env.VITE_NETLIFY_DEPLOY === 'true' || import.meta.env.PROD === true
  const useBackground = useAiChatBackground()
  const maxAttempts = Math.max(
    1,
    Math.min(deploy ? 2 : 3, options?.maxAttempts ?? (deploy ? 2 : 2)),
  )

  const apiBody = {
    messages,
    contextDescription,
    images,
    skipRefine: true,
    practiceContext: options?.practiceContext,
    chatGuidance: options?.chatGuidance,
    hasImages: options?.hasImages,
  }

  let lastError = new Error('요청에 실패했습니다.')

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      if (useBackground) {
        try {
          return await sendOpenAiChatViaBackgroundJob(apiBody, options)
        } catch (bgErr) {
          if (!shouldFallbackFromBackground(bgErr)) throw bgErr
          options?.onStatus?.(
            'Pro 백그라운드 연결에 문제가 있어 빠른 모드로 다시 시도합니다…',
          )
          return await sendOpenAiChatStreaming(
            messages,
            contextDescription,
            images,
            options,
          )
        }
      }

      if (options?.stream !== false) {
        return await sendOpenAiChatStreaming(
          messages,
          contextDescription,
          images,
          options,
        )
      }

      const res = await fetch(getChatApiUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...apiBody, stream: false }),
        signal: AbortSignal.timeout(getChatClientTimeoutMs()),
      })
      const raw = await res.text()
      if (!res.ok) throw new Error(parseApiError(raw, res.status))
      const data = JSON.parse(raw)
      const text = data.choices?.[0]?.message?.content?.trim()
      if (!text) throw new Error('모델 응답이 비어 있습니다.')
      return text
    } catch (e) {
      const normalized = normalizeChatFetchError(e)
      lastError = new Error(normalized)
      const msg = lastError.message
      if (attempt >= maxAttempts - 1 || !isRetryableErrorMessage(msg)) {
        throw lastError
      }
      await sleep(deploy ? 2500 : 2000)
    }
  }

  throw lastError
}
