/**
 * 개발 서버(Vite)가 /api/openai/chat 으로 OpenAI를 프록시합니다.
 * API 키는 .env 의 OPENAI_API_KEY 만 사용하고 브라우저로 보내지 않습니다.
 */
export function isOpenAiProxyAvailable() {
  return import.meta.env.DEV
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
    let detail = raw
    try {
      const j = JSON.parse(raw)
      detail = j.error?.message || j.error || raw
    } catch {
      /* ignore */
    }
    throw new Error(
      typeof detail === 'string' ? detail : `요청 실패 (${res.status})`,
    )
  }

  let data
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error('응답 파싱에 실패했습니다.')
  }

  const text = data.choices?.[0]?.message?.content?.trim()
  if (!text) throw new Error('모델 응답이 비어 있습니다.')
  return text
}
