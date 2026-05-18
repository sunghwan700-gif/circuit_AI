/**
 * AI 프록시 사용 가능 여부.
 * - 로컬: Vite dev 서버가 /api/openai/chat 을 처리합니다.
 * - Netlify: netlify.toml 이 같은 경로를 Function으로 넘깁니다. 키는 Netlify 환경 변수에만 두세요.
 */
export function isOpenAiProxyAvailable() {
  return true
}

/**
 * @param {string} raw
 * @param {number} status
 */
function parseApiError(raw, status) {
  const text = String(raw || '').trim()
  if (!text) return `요청 실패 (${status})`

  if (
    /^\s*</.test(text) ||
    /<TITLE>\s*Inactivity Timeout\s*<\/TITLE>/i.test(text) ||
    /Inactivity Timeout/i.test(text) ||
    /Too much time has passed without sending any data/i.test(text)
  ) {
    return '서버 응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요. (회로도 1장만 올린 뒤 질문해 보세요.)'
  }

  if (
    /timed?\s*out|execution timed out|function invocation|deadline exceeded/i.test(
      text,
    )
  ) {
    return '서버 응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요. (회로도 1장만 올린 뒤 질문하면 더 안정적입니다.)'
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
  return /응답 시간|Inactivity|일시적|502|503|504|과부하|빈 응답|timed out|deadline|요청 실패 \(5/i.test(
    msg,
  )
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * @param {{ role: string, content: string }[]} messages
 * @param {string} contextDescription
 * @param {{ dataUrl: string, label?: string }[]=} images
 * @param {{ skipRefine?: boolean, maxAttempts?: number }=} options
 */
async function sendOpenAiChatOnce(messages, contextDescription, images, options) {
  const body = { messages, contextDescription, images }
  if (options?.skipRefine) body.skipRefine = true

  let bodyJson
  try {
    bodyJson = JSON.stringify(body)
  } catch {
    throw new Error(
      '대화·이미지 데이터가 너무 큽니다. 사진 수를 줄이거나 페이지를 새로고침한 뒤 다시 시도해 주세요.',
    )
  }
  const maxBytes = 5_200_000
  if (bodyJson.length > maxBytes) {
    throw new Error(
      '이미지·대화 내용이 서버 한도를 넘었습니다. 회로도 1장과 실습 사진 2장 이하로 줄여 다시 질문해 주세요.',
    )
  }

  const res = await fetch('/api/openai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: bodyJson,
  })

  const raw = await res.text()
  if (!res.ok) {
    throw new Error(parseApiError(raw, res.status))
  }

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

/**
 * @param {{ role: string, content: string }[]} messages
 * @param {string} contextDescription
 * @param {{ dataUrl: string, label?: string }[]=} images
 * @param {{ skipRefine?: boolean, maxAttempts?: number }=} options
 */
export async function sendOpenAiChat(messages, contextDescription, images, options) {
  const maxAttempts = Math.max(1, Math.min(4, options?.maxAttempts ?? 3))
  let lastError = new Error('요청에 실패했습니다.')

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await sendOpenAiChatOnce(messages, contextDescription, images, options)
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
      const msg = lastError.message
      const canRetry =
        attempt < maxAttempts - 1 && isRetryableErrorMessage(msg)
      if (!canRetry) throw lastError
      await sleep(1400 * (attempt + 1))
    }
  }

  throw lastError
}
