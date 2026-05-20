import { readAiChatJob } from '../../../server/ai-chat-jobs.mjs'
import { processAiChatJob } from '../../../server/process-ai-chat-job.mjs'
import { deployEnv } from '../../../server/deploy-env.mjs'
import { corsHeaders } from '../../../server/vercel-http.mjs'

export const config = {
  maxDuration: 60,
  runtime: 'nodejs',
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() })
  }

  if (request.method !== 'POST') {
    return new Response(null, { status: 405 })
  }

  let payload
  try {
    payload = await request.json()
  } catch {
    return new Response(null, { status: 400 })
  }

  const jobId = String(payload?.jobId || '').trim()
  if (!jobId) {
    return new Response(null, { status: 400 })
  }

  let requestBody = payload?.request
  if (!requestBody || typeof requestBody !== 'object') {
    const job = await readAiChatJob(jobId)
    requestBody = job?.request
  }
  if (!requestBody || typeof requestBody !== 'object') {
    return new Response(null, { status: 400 })
  }

  await processAiChatJob(jobId, requestBody, deployEnv())
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8' },
  })
}
