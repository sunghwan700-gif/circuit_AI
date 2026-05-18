/**
 * AI 프록시 사용 가능 여부.
 * - 로컬: Vite dev 서버가 /api/openai/chat 을 처리합니다.
 * - Netlify: Function (스트리밍·heartbeat)
 */
export function isOpenAiProxyAvailable() {
  return true
}

function getChatApiUrl() {
  const deploy =
    import.meta.env.VITE_NETLIFY_DEPLOY === 'true' || import.meta.env.PROD === true
  return deploy ? '/.netlify/functions/openai-chat' : '/api/openai/chat'
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
  return /일시적|502|503|504|과부하|빈 응답/i.test(msg)
}

function getChatClientTimeoutMs() {
  const deploy =
    import.meta.env.VITE_NETLIFY_DEPLOY === 'true' || import.meta.env.PROD === true
  return deploy ? 90_000 : 180_000
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * @param {ReadableStream<Uint8Array>} body
 * @param {(ev: { event: string, text?: string, message?: string }) => void} onEvent
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
 * @param {{ role: string, content: string }[]} messages
 * @param {string} contextDescription
 * @param {{ dataUrl: string, label?: string }[]=} images
 * @param {{ skipRefine?: boolean, onStatus?: (msg: string) => void }=} options
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
    }
  })

  if (!resultText.trim()) {
    throw new Error('모델 응답이 비어 있습니다.')
  }
  return resultText.trim()
}

/**
 * @param {{ role: string, content: string }[]} messages
 * @param {string} contextDescription
 * @param {{ dataUrl: string, label?: string }[]=} images
 * @param {{ skipRefine?: boolean, maxAttempts?: number, onStatus?: (msg: string) => void }=} options
 */
export async function sendOpenAiChat(messages, contextDescription, images, options) {
  const deploy =
    import.meta.env.VITE_NETLIFY_DEPLOY === 'true' || import.meta.env.PROD === true
  const maxAttempts = Math.max(
    1,
    Math.min(deploy ? 2 : 3, options?.maxAttempts ?? (deploy ? 2 : 2)),
  )

  let lastError = new Error('요청에 실패했습니다.')

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      if (options?.stream !== false) {
        return await sendOpenAiChatStreaming(
          messages,
          contextDescription,
          images,
          options,
        )
      }
      const body = { messages, contextDescription, images, stream: false }
      if (options?.skipRefine) body.skipRefine = true
      const res = await fetch(getChatApiUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
