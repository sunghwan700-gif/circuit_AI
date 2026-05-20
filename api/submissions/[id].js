import { handleSubmissionsEvent } from '../../server/submissions-handler.mjs'
import {
  requestToEvent,
  lambdaResultToResponse,
  corsHeaders,
} from '../../server/vercel-http.mjs'
import { withApiErrorGuard } from '../../server/wrap-vercel-api.mjs'

export const config = {
  maxDuration: 30,
  runtime: 'nodejs',
}

async function handler(request, context) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() })
  }
  const id = String(context?.params?.id || '').trim()
  const event = await requestToEvent(request, { id })
  event.queryStringParameters = {
    ...(event.queryStringParameters || {}),
    mode: 'record',
    rid: id,
  }
  return lambdaResultToResponse(await handleSubmissionsEvent(event))
}

export default withApiErrorGuard(handler)
