import { handleSubmissionsEvent } from '../_bundled/submissions-handler.mjs'
import {
  requestToEvent,
  lambdaResultToResponse,
  corsHeaders,
  withApiErrorGuard,
} from '../_bundled/http-utils.mjs'

export const config = {
  maxDuration: 30,
  runtime: 'nodejs',
}

async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() })
  }
  const event = await requestToEvent(request)
  return lambdaResultToResponse(await handleSubmissionsEvent(event))
}

export default withApiErrorGuard(handler)
