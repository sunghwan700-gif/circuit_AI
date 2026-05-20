/**
 * Vercel API 라우트 ↔ Lambda 스타일 핸들러 어댑터
 */

export function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods':
      'GET, PUT, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, If-Match',
    ...extra,
  }
}

/** @param {Request} request @param {Record<string, string>} [params] */
export async function requestToEvent(request, params = {}) {
  const url = new URL(request.url)
  const query = Object.fromEntries(url.searchParams.entries())
  const method = request.method || 'GET'
  let body = ''
  if (method !== 'GET' && method !== 'HEAD') {
    body = await request.text()
  }

  return {
    httpMethod: method,
    path: url.pathname,
    rawUrl: request.url,
    headers: Object.fromEntries(request.headers.entries()),
    queryStringParameters: query,
    body,
    pathParameters: params,
  }
}

/** @param {{ statusCode: number, headers?: Record<string, string>, body?: string }} result */
export function lambdaResultToResponse(result) {
  return new Response(result.body ?? '', {
    status: result.statusCode,
    headers: result.headers || {},
  })
}

/** @param {(event: any) => Promise<any>} handler */
export function wrapLambdaHandler(handler) {
  return async (request, context) => {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }
    const params = context?.params || {}
    const event = await requestToEvent(request, params)
    const result = await handler(event)
    return lambdaResultToResponse(result)
  }
}
