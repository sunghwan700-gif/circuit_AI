/**
 * Netlify Background Function — Pro 채팅 (최대 ~15분, 26초 동기 한도 회피)
 */
import { runGeminiChatProxy } from '../../server/gemini-chat-core.mjs'
import { readAiChatJob, writeAiChatJob } from '../../server/ai-chat-jobs.mjs'

const bgEnv = () => ({
  ...process.env,
  NETLIFY: 'true',
  /** 백그라운드에서는 Pro 정밀 모드(이어쓰기·긴 타임아웃) 허용 */
  GEMINI_NETLIFY_FAST: '0',
  GEMINI_FETCH_TIMEOUT_MS: String(
    process.env.GEMINI_BG_FETCH_TIMEOUT_MS || 120000,
  ),
})

export default async (request) => {
  let payload
  try {
    payload = await request.json()
  } catch {
    return new Response(null, { status: 400 })
  }

  const jobId = String(payload?.jobId || '').trim()
  const requestBody = payload?.request
  if (!jobId || !requestBody || typeof requestBody !== 'object') {
    return new Response(null, { status: 400 })
  }

  try {
    await writeAiChatJob(jobId, {
      status: 'running',
      message: 'Pro 모델로 회로·사진을 분석하는 중입니다…',
    })

    const body = { ...requestBody, stream: false, skipRefine: true }
    const result = await runGeminiChatProxy(body, bgEnv())

    if (!result.ok) {
      let msg = '요청에 실패했습니다.'
      try {
        const j = JSON.parse(result.body)
        msg = j.error?.message || msg
      } catch {
        /* ignore */
      }
      await writeAiChatJob(jobId, {
        status: 'error',
        message: msg,
      })
      return new Response(null, { status: 200 })
    }

    let text = ''
    let model = ''
    try {
      const j = JSON.parse(result.body)
      text = j.choices?.[0]?.message?.content || ''
      model = j.meta?.model || ''
    } catch {
      /* ignore */
    }

    if (!String(text).trim()) {
      await writeAiChatJob(jobId, {
        status: 'error',
        message:
          'AI가 답변을 만들지 못했습니다. 사진을 줄이고 다시 시도해 주세요.',
      })
      return new Response(null, { status: 200 })
    }

    await writeAiChatJob(jobId, {
      status: 'done',
      text: String(text).trim(),
      model: model || undefined,
      message: '완료',
    })
  } catch (e) {
    await writeAiChatJob(jobId, {
      status: 'error',
      message: e instanceof Error ? e.message : String(e),
    })
  }

  return new Response(null, { status: 200 })
}
