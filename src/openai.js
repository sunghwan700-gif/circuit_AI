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
