import {
  runGeminiChatProxy,
  runGeminiChatWithHeartbeat,
} from '../../server/gemini-chat-core.mjs'

const netlifyEnv = () => ({ ...process.env, NETLIFY: 'true' })

/** Netlify Functions 2 (Request/Response) — 스트리밍 + heartbeat */
export default async (request) => {
  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: { message: 'Method Not Allowed' } }),
      {
        status: 405,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      },
    )
  }

  let body
  try {
    body = await request.json()
  } catch {
    return new Response(JSON.stringify({ error: { message: 'Invalid JSON' } }), {
      status: 400,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
  }

  const useStream = body.stream !== false
  if (useStream) {
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        const push = (obj) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`))
        }
        await runGeminiChatWithHeartbeat(body, netlifyEnv(), push)
        controller.close()
      },
    })
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    })
  }

  const result = await runGeminiChatProxy(body, netlifyEnv())
  return new Response(result.body, {
    status: result.statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

/** 레거시 (비스트리밍) */
export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: { message: 'Method Not Allowed' } }),
    }
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: { message: 'Invalid JSON' } }),
    }
  }

  body.stream = false
  const result = await runGeminiChatProxy(body, netlifyEnv())
  return {
    statusCode: result.statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: result.body,
  }
}
