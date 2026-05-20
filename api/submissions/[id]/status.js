import { handleSubmissionsEvent } from '../../_bundled/submissions-handler.mjs'
import {
  reqToEvent,
  sendLambdaResult,
  corsHeaders,
  withNodeHandler,
} from '../../_bundled/node-adapter.mjs'

export const config = {
  maxDuration: 30,
}

export default withNodeHandler(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders())
    res.end()
    return
  }
  const id = String(req.query?.id || '').trim()
  const event = await reqToEvent(req, { id })
  event.queryStringParameters = {
    ...(event.queryStringParameters || {}),
    mode: 'status',
    rid: id,
  }
  sendLambdaResult(res, await handleSubmissionsEvent(event))
})
