/**
 * Vercel Serverless — Gemini 2.5 Pro NDJSON 스트리밍
 * POST /api/openai/chat
 */
import { runGeminiChatWithHeartbeat } from '../../server/gemini-chat-core.mjs'
import { deployEnv } from '../../server/deploy-env.mjs'
import { corsHeaders } from '../../server/vercel-http.mjs'

export const config = {
  maxDuration: 300,
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
        controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`))
      }
      await runGeminiChatWithHeartbeat(body, env, push)
      controller.close()
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
}
