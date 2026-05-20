/**
 * Vercel Serverless — Gemini 2.5 Pro NDJSON 스트리밍
 * POST /api/openai/chat
 */
import { runGeminiChatWithHeartbeat } from '../../server/gemini-chat-core.mjs'
import { deployEnv } from '../../server/deploy-env.mjs'
import { corsHeaders } from '../../server/vercel-http.mjs'

/** Hobby 60s / Pro 300s — 플랜 초과 시 배포·실행 오류 방지 */
export const config = {
  maxDuration: 60,
  runtime: 'nodejs',
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

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() })
  }

  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: { message: 'Method Not Allowed' } }),
      {
        status: 405,
        headers: {
          ...corsHeaders(),
          'Content-Type': 'application/json; charset=utf-8',
        },
      },
    )
  }

  try {
    let body
    try {
      body = await request.json()
    } catch {
      return new Response(JSON.stringify({ error: { message: 'Invalid JSON' } }), {
        status: 400,
        headers: {
          ...corsHeaders(),
          'Content-Type': 'application/json; charset=utf-8',
        },
      })
    }

    body.stream = true
    const env = deployEnv()

    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        const push = (obj) => {
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`))
          } catch {
            /* client disconnected */
          }
        }
        push({ event: 'status', message: '서버에 연결되었습니다…' })
        try {
          await runGeminiChatWithHeartbeat(body, env, push)
        } catch (e) {
          push({ event: 'error', message: friendlyHandlerError(e) })
        } finally {
          try {
            controller.close()
          } catch {
            /* ignore */
          }
        }
      },
    })

    return new Response(stream, {
      status: 200,
      headers: {
        ...corsHeaders(),
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    })
  } catch (e) {
    return new Response(
      JSON.stringify({
        error: { message: friendlyHandlerError(e) },
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders(),
          'Content-Type': 'application/json; charset=utf-8',
        },
      },
    )
  }
}
