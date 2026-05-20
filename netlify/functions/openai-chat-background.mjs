import { readAiChatJob } from '../../server/ai-chat-jobs.mjs'
import { processAiChatJob } from '../../server/process-ai-chat-job.mjs'
import { deployEnv } from '../../server/deploy-env.mjs'

export default async (request) => {
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
  return new Response(null, { status: 200 })
}
