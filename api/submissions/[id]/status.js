import { handleSubmissionsEvent } from '../../_bundled/submissions-handler.mjs'
import {
  requestToEvent,
  lambdaResultToResponse,
  corsHeaders,
  withApiErrorGuard,
} from '../../_bundled/http-utils.mjs'

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
    mode: 'status',
    rid: id,
  }
  return lambdaResultToResponse(await handleSubmissionsEvent(event))
}

export default withApiErrorGuard(handler)
