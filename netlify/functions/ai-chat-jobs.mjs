/**
 * AI 채팅 작업 시작(202) + 상태 조회(GET)
 */
import {
  createPendingAiChatJob,
  readAiChatJob,
  triggerAiChatBackground,
} from '../../server/ai-chat-jobs.mjs'

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
  }
}

export default async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors() })
  }

  const url = new URL(request.url)
  const jobId = (url.searchParams.get('jobId') || '').trim()

  if (request.method === 'GET') {
    if (!jobId) {
      return new Response(JSON.stringify({ error: { message: 'jobId required' } }), {
        status: 400,
        headers: cors(),
      })
    }
    const job = await readAiChatJob(jobId)
    if (!job) {
      return new Response(JSON.stringify({ error: { message: 'Job not found' } }), {
        status: 404,
        headers: cors(),
      })
    }
    return new Response(JSON.stringify(job), { status: 200, headers: cors() })
  }

  if (request.method === 'POST') {
    let body
    try {
      body = await request.json()
    } catch {
      return new Response(JSON.stringify({ error: { message: 'Invalid JSON' } }), {
        status: 400,
        headers: cors(),
      })
    }

    const id = await createPendingAiChatJob(body)
    // Pro 분석: Background Function(최대 ~15분). 브라우저·서버 둘 다 트리거해 누락 방지.
    const siteBase = String(
      process.env.DEPLOY_PRIME_URL || process.env.URL || '',
    ).trim()
    if (siteBase) {
      try {
        await triggerAiChatBackground(siteBase, id, body)
      } catch {
        /* 클라이언트가 재시도 */
      }
    }

    return new Response(JSON.stringify({ jobId: id, status: 'pending' }), {
      status: 202,
      headers: cors(),
    })
  }

  return new Response(JSON.stringify({ error: { message: 'Method Not Allowed' } }), {
    status: 405,
    headers: cors(),
  })
}
