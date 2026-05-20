/**
 * Vercel Serverless — Gemini 2.5 Pro NDJSON 스트리밍
 * POST /api/openai/chat
 */
import {
  runGeminiChatWithHeartbeat,
  deployEnv,
} from '../_bundled/gemini-api.mjs'
import {
  streamNdjson,
  corsHeaders,
  withNodeHandler,
} from '../_bundled/node-adapter.mjs'

export const config = {
  maxDuration: 60,
}

function friendlyHandlerError(err) {
  const msg = err instanceof Error ? err.message : String(err || '')
  if (/GEMINI_API_KEY|GOOGLE_API_KEY/i.test(msg)) {
    return '서버에 GEMINI_API_KEY가 설정되어 있지 않습니다. Vercel 환경 변수를 확인한 뒤 재배포하세요.'
  }
  if (/deployment|FUNCTION_INVOCATION|failed to load|Cannot find module/i.test(msg)) {
    return 'AI 서버 설정 오류입니다. Vercel Functions 로그를 확인하거나 잠시 후 다시 시도해 주세요.'
  }
  return msg || 'AI 요청 처리 중 오류가 발생했습니다.'
}

export default withNodeHandler(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders())
    res.end()
    return
  }

  if (req.method !== 'POST') {
    res.statusCode = 405
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.end(JSON.stringify({ error: { message: 'Method Not Allowed' } }))
    return
  }

  let body
  try {
    const raw =
      typeof req.body === 'string'
        ? req.body
        : req.body
          ? JSON.stringify(req.body)
          : await new Promise((resolve, reject) => {
              const chunks = []
              req.on('data', (c) => chunks.push(c))
              req.on('end', () =>
                resolve(Buffer.concat(chunks).toString('utf8')),
              )
              req.on('error', reject)
            })
    body = JSON.parse(raw || '{}')
  } catch {
    res.statusCode = 400
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }))
    return
  }

  body.stream = true
  const env = deployEnv()

  await streamNdjson(res, async (push) => {
    push({ event: 'status', message: '서버에 연결되었습니다…' })
    try {
      await runGeminiChatWithHeartbeat(body, env, push)
    } catch (e) {
      push({ event: 'error', message: friendlyHandlerError(e) })
    }
  })
})
