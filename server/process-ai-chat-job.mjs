/**
 * AI 채팅 작업 실행 (로컬·Vercel background 공용)
 */
import { runGeminiChatProxy } from './gemini-chat-core.mjs'
import { writeAiChatJob } from './ai-chat-jobs.mjs'

/** @param {Record<string, string | undefined>} baseEnv */
function jobEnv(baseEnv = {}) {
  return {
    ...baseEnv,
    ...process.env,
    VERCEL: process.env.VERCEL ? '1' : baseEnv.VERCEL || '',
    GEMINI_BG_JOB: '1',
    GEMINI_SERVERLESS_COMPACT: '0',
    GEMINI_FETCH_TIMEOUT_MS: String(
      baseEnv.GEMINI_BG_FETCH_TIMEOUT_MS ||
        process.env.GEMINI_BG_FETCH_TIMEOUT_MS ||
        180000,
    ),
  }
}

function isTransientFailure(result, message = '') {
  const msg = String(message || '').toLowerCase()
  if (result?.ok) return false
  const code = result?.statusCode || 0
  if (code === 429 || code === 503 || code === 502 || code === 504) return true
  return /바쁘|overloaded|unavailable|resource_exhausted|high demand|try again|timeout|timed out|empty_response|빈 응답|일시적/i.test(
    msg,
  )
}

/**
 * @param {string} jobId
 * @param {object} requestBody
 * @param {Record<string, string | undefined>} env
 */
export async function processAiChatJob(jobId, requestBody, env = {}) {
  const maxAttempts = 3
  let lastMsg = 'AI 분석에 실패했습니다.'

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await writeAiChatJob(jobId, {
        status: 'running',
        message: `Pro 재시도 중… (${attempt + 1}/${maxAttempts})`,
      })
      await new Promise((r) => setTimeout(r, 2500 * attempt))
    } else {
      await writeAiChatJob(jobId, {
        status: 'running',
        message: 'Pro 모델로 회로·사진을 분석하는 중입니다…',
      })
    }

    try {
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
        lastMsg = msg
        if (isTransientFailure(result, msg) && attempt < maxAttempts - 1) {
          continue
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
        lastMsg =
          'AI가 답변을 만들지 못했습니다. 회로도 1장만 올리고 짧게 질문해 주세요.'
        if (attempt < maxAttempts - 1) continue
        await writeAiChatJob(jobId, { status: 'error', message: lastMsg })
        return
      }

      await writeAiChatJob(jobId, {
        status: 'done',
        text: String(text).trim(),
        model: model || undefined,
        message: '완료',
      })
      return
    } catch (e) {
      lastMsg = e instanceof Error ? e.message : String(e)
      if (isTransientFailure(null, lastMsg) && attempt < maxAttempts - 1) {
        continue
      }
      await writeAiChatJob(jobId, { status: 'error', message: lastMsg })
      return
    }
  }

  await writeAiChatJob(jobId, { status: 'error', message: lastMsg })
}
