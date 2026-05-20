import { handleSubmissionsEvent } from '../../../server/submissions-handler.mjs'
import {
  requestToEvent,
  lambdaResultToResponse,
  corsHeaders,
} from '../../../server/vercel-http.mjs'
import { withApiErrorGuard } from '../../../server/wrap-vercel-api.mjs'

export const config = {
  maxDuration: 30,
  runtime: 'nodejs',
}

async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() })
  }
  const event = await requestToEvent(request)
  event.queryStringParameters = {
    ...(event.queryStringParameters || {}),
    mode: 'auth',
  }
  return lambdaResultToResponse(await handleSubmissionsEvent(event))
}

export default withApiErrorGuard(handler)
