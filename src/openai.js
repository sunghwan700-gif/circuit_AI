/**
 * AI 채팅
 * - 로컬 npm run dev: Pro 스트리밍 (긴 대기)
 * - Netlify 배포: Pro 백그라운드 + 폴링 (26초 동기 한도 회피, Flash 폴백 없음)
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

function isNetlifyProduction() {
  return (
    import.meta.env.VITE_NETLIFY_DEPLOY === 'true' || import.meta.env.PROD === true
  )
}

/** 배포 + Pro: 백그라운드(타임아웃 방지). 로컬은 스트리밍 */
export function useAiChatBackground() {
  if (!isNetlifyProduction()) return false
  if (import.meta.env.VITE_AI_CHAT_BACKGROUND === 'false') return false
  if (import.meta.env.VITE_AI_CHAT_BACKGROUND === 'true') return true
  const m = String(
    import.meta.env.VITE_GEMINI_CHAT_MODEL ||
      import.meta.env.VITE_GEMINI_MODEL ||
      '',
  ).toLowerCase()
  return /pro/.test(m)
}

function getBackgroundTriggerUrls() {
  if (!isNetlifyProduction()) return []
  return ['/api/openai/chat/background', '/.netlify/functions/openai-chat-background']
}

/** @param {unknown} err */
export function normalizeChatFetchError(err) {
  const msg = err instanceof Error ? err.message : String(err || '')
  if (/failed to fetch|networkerror|load failed|aborterror/i.test(msg)) {
    return '서버에 연결하지 못했습니다. 새로고침 후 다시 시도해 주세요.'
  }
  if (/abort|timeout|timed out/i.test(msg)) {
    return '연결이 끊겼습니다. 같은 질문을 한 번 더 보내 주세요.'
  }
  return msg
}

function parseApiError(raw, status) {
  const text = String(raw || '').trim()
  if (!text) return `요청 실패 (${status})`

  try {
    const j = JSON.parse(text)
    const detail = j.error?.message || j.error
    if (typeof detail === 'string' && detail.trim()) return detail.trim()
  } catch {
    /* ignore */
  }

  if (
    /Inactivity Timeout|timed?\s*out|deadline exceeded|execution timed out/i.test(
      text,
    )
  ) {
    return '분석이 아직 진행 중이거나 서버 한도에 걸렸습니다. 잠시 후 같은 질문을 다시 보내 주세요.'
  }

  if (status === 504 || status === 502 || status === 503) {
    return 'AI 서버가 일시적으로 바쁩니다. 10~20초 뒤 같은 질문을 다시 보내 주세요.'
  }

  if (text.length > 280) {
    return `요청 실패 (${status}). 잠시 후 다시 시도해 주세요.`
  }
  return text
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function isTransientChatError(err) {
  const msg = (
    err instanceof Error ? err.message : String(err || '')
  ).toLowerCase()
  return (
    /바쁘|일시적|overloaded|unavailable|resource_exhausted|high demand|try again|503|502|504|429|timeout|timed out|빈 응답|empty|연결이 끊|분석이 아직|실패했습니다/.test(
      msg,
    ) && !/quota|billing|api key|키가 설정|invalid.*key/i.test(msg)
  )
}

async function withAutoRetry(task, options, maxAttempts = 3) {
  let lastErr
  for (let i = 0; i < maxAttempts; i++) {
    try {
      if (i > 0) {
        options?.onStatus?.(
          `잠시 기다린 뒤 다시 시도합니다… (${i + 1}/${maxAttempts})`,
        )
        await sleep(5000 * i)
      }
      return await task()
    } catch (e) {
      lastErr = e
      if (!isTransientChatError(e) || i >= maxAttempts - 1) throw e
    }
  }
  throw lastErr
}

async function triggerBackgroundWorker(jobId, requestBody) {
  const urls = getBackgroundTriggerUrls()
  if (!urls.length || !jobId) return false

  const payload = JSON.stringify({ jobId, request: requestBody })
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: payload,
      })
      if (r.status === 202 || r.ok) return true
    } catch {
      /* 다음 URL */
    }
  }
  return false
}

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
        /* ignore */
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

async function sendOpenAiChatViaBackgroundJob(apiBody, options) {
  const bodyJson = JSON.stringify(apiBody)
  if (bodyJson.length > 5_200_000) {
    throw new Error(
      '이미지·대화 내용이 너무 큽니다. 회로도 1장과 질문만 짧게 보내 주세요.',
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
    jobId = String(JSON.parse(startRaw).jobId || '').trim()
  } catch {
    throw new Error('분석 작업을 시작하지 못했습니다.')
  }
  if (!jobId) throw new Error('작업 ID를 받지 못했습니다.')

  void triggerBackgroundWorker(jobId, apiBody)

  options?.onStatus?.('Pro 분석 중… 완료까지 1~3분 걸릴 수 있습니다.')

  const deadline = Date.now() + 300_000
  let polls = 0
  let lastTrigger = Date.now()

  while (Date.now() < deadline) {
    await sleep(polls < 3 ? 1500 : 2000)
    polls += 1

    let stRes
    try {
      stRes = await fetch(
        `${getChatJobApiUrl()}?jobId=${encodeURIComponent(jobId)}`,
      )
    } catch {
      continue
    }

    const stRaw = await stRes.text()
    if (!stRes.ok) {
      if (stRes.status === 404 && polls < 8) continue
      if ((stRes.status === 502 || stRes.status === 503) && polls < 30) {
        continue
      }
      throw new Error(parseApiError(stRaw, stRes.status))
    }

    let job
    try {
      job = JSON.parse(stRaw)
    } catch {
      continue
    }

    const status = String(job.status || '')

    if (status === 'pending' || status === 'running') {
      if (Date.now() - lastTrigger > 12_000) {
        lastTrigger = Date.now()
        void triggerBackgroundWorker(jobId, apiBody)
      }
      options?.onStatus?.(
        status === 'pending'
          ? 'Pro 분석 준비 중…'
          : String(job.message || '') || 'Pro 모델로 분석하는 중…',
      )
      continue
    }

    if (status === 'done') {
      const text = String(job.text || '').trim()
      if (!text) throw new Error('AI가 빈 답변을 반환했습니다.')
      options?.onStatus?.('Pro 분석 완료')
      return text
    }

    if (status === 'error') {
      throw new Error(String(job.message || 'AI 분석에 실패했습니다.'))
    }
  }

  throw new Error(
    'Pro 분석이 오래 걸리고 있습니다. 회로도 1장만 올리고 같은 질문을 다시 보내 주세요.',
  )
}

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
    throw new Error('이미지·대화가 너무 큽니다. 사진 수를 줄여 주세요.')
  }

  const res = await fetch(getChatApiUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/x-ndjson',
    },
    body: bodyJson,
    signal: AbortSignal.timeout(180_000),
  })

  if (!res.ok) {
    throw new Error(parseApiError(await res.text(), res.status))
  }

  const ctype = res.headers.get('content-type') || ''
  if (!ctype.includes('ndjson') || !res.body) {
    const data = JSON.parse(await res.text())
    const text = data.choices?.[0]?.message?.content?.trim()
    if (!text) throw new Error('AI가 빈 답변을 반환했습니다.')
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
    }
  })

  if (!resultText.trim()) {
    throw new Error('AI가 빈 답변을 반환했습니다.')
  }
  return resultText.trim()
}

export async function sendOpenAiChat(
  messages,
  contextDescription,
  images,
  options = {},
) {
  const apiBody = {
    messages,
    contextDescription,
    images,
    skipRefine: true,
    practiceContext: options.practiceContext,
    chatGuidance: options.chatGuidance,
    hasImages: options.hasImages,
  }

  return await withAutoRetry(async () => {
    if (useAiChatBackground()) {
      return await sendOpenAiChatViaBackgroundJob(apiBody, options)
    }
    return await sendOpenAiChatStreaming(
      messages,
      contextDescription,
      images,
      options,
    )
  }, options)
}
