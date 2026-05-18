/**
 * AI 프록시 사용 가능 여부.
 * - 로컬: Vite dev 서버가 /api/openai/chat 을 처리합니다.
 * - Netlify: netlify.toml 이 같은 경로를 Function으로 넘깁니다. 키는 Netlify 환경 변수에만 두세요.
 * (정적 호스팅만 하고 프록시가 없으면 요청이 404가 되어 챗봇에서 오류로 보입니다.)
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
    return '서버 응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요. (회로도·사진이 크면 한 장만 올린 뒤 질문해 보세요.)'
  }

  if (status === 504 || status === 502 || status === 503) {
    return 'AI 서버가 일시적으로 응답하지 않습니다. 잠시 후 다시 시도해 주세요.'
  }

  try {
    const j = JSON.parse(text)
    const detail = j.error?.message || j.error
    if (typeof detail === 'string' && detail.trim()) return detail.trim()
  } catch {
    /* ignore */
  }

  if (text.length > 280) {
    return `요청 실패 (${status}). 잠시 후 다시 시도해 주세요.`
  }
  return text
}

/**
 * @param {{ role: string, content: string }[]} messages
 * @param {string} contextDescription
 * @param {{ dataUrl: string, label?: string }[]=} images
 * @param {{ skipRefine?: boolean }=} options 서버의 2차 보강(refine) 호출을 건너뜁니다(이미지 없는 짧은 질문 등).
 */
export async function sendOpenAiChat(messages, contextDescription, images, options) {
  const body = { messages, contextDescription, images }
  if (options?.skipRefine) body.skipRefine = true
  const res = await fetch('/api/openai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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
