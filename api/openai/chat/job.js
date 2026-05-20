import { waitUntil } from '@vercel/functions'
import {
  createPendingAiChatJob,
  readAiChatJob,
  triggerAiChatBackground,
} from '../../../server/ai-chat-jobs.mjs'
import { processAiChatJob } from '../../../server/process-ai-chat-job.mjs'
import { deployEnv, getSiteBaseUrl } from '../../../server/deploy-env.mjs'
import { corsHeaders } from '../../../server/vercel-http.mjs'

export const config = {
  maxDuration: 300,
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() })
  }

  const url = new URL(request.url)
  const jobId = (url.searchParams.get('jobId') || '').trim()

  if (request.method === 'GET') {
    if (!jobId) {
      return new Response(JSON.stringify({ error: { message: 'jobId required' } }), {
        status: 400,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8' },
      })
    }
    const job = await readAiChatJob(jobId)
    if (!job) {
      return new Response(JSON.stringify({ error: { message: 'Job not found' } }), {
        status: 404,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8' },
      })
    }
    return new Response(JSON.stringify(job), {
      status: 200,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8' },
    })
  }

  if (request.method === 'POST') {
    let body
    try {
      body = await request.json()
    } catch {
      return new Response(JSON.stringify({ error: { message: 'Invalid JSON' } }), {
        status: 400,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8' },
      })
    }

    const id = await createPendingAiChatJob(body)
    const env = deployEnv()

    waitUntil(processAiChatJob(id, body, env))

    const siteBase = getSiteBaseUrl(request)
    if (siteBase) {
      try {
        await triggerAiChatBackground(siteBase, id, body)
      } catch {
        /* waitUntil + 클라이언트 재시도 */
      }
    }

    return new Response(JSON.stringify({ jobId: id, status: 'pending' }), {
      status: 202,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8' },
    })
  }

  return new Response(JSON.stringify({ error: { message: 'Method Not Allowed' } }), {
    status: 405,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8' },
  })
}
