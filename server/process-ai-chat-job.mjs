/**
 * AI 채팅 작업 실행 (로컬·Netlify Background·waitUntil 공용)
 */
import { runGeminiChatProxy } from './gemini-chat-core.mjs'
import { writeAiChatJob } from './ai-chat-jobs.mjs'

/** @param {Record<string, string | undefined>} baseEnv */
function jobEnv(baseEnv = {}) {
  return {
    ...baseEnv,
    ...process.env,
    NETLIFY: 'true',
    GEMINI_BG_JOB: '1',
    GEMINI_NETLIFY_FAST: '0',
    GEMINI_FETCH_TIMEOUT_MS: String(
      baseEnv.GEMINI_BG_FETCH_TIMEOUT_MS ||
        process.env.GEMINI_BG_FETCH_TIMEOUT_MS ||
        120000,
    ),
  }
}

/**
 * @param {string} jobId
 * @param {object} requestBody
 * @param {Record<string, string | undefined>} env
 */
export async function processAiChatJob(jobId, requestBody, env = {}) {
  try {
    await writeAiChatJob(jobId, {
      status: 'running',
      message: 'Pro 모델로 회로·사진을 분석하는 중입니다…',
    })

    const result = await runGeminiChatProxy(
      { ...requestBody, stream: false, skipRefine: true },
      jobEnv(env),
    )

    if (!result.ok) {
      let msg = '요청에 실패했습니다.'
      try {
        const j = JSON.parse(result.body)
        msg = j.error?.message || msg
      } catch {
        /* ignore */
      }
      await writeAiChatJob(jobId, { status: 'error', message: msg })
      return
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
          'AI가 답변을 만들지 못했습니다. 회로도 1장만 올리고 짧게 질문해 주세요.',
      })
      return
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
}
