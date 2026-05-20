/**
 * Vercel API 라우트 공통 — 런타임 오류를 JSON으로 반환
 */
import { corsHeaders } from './vercel-http.mjs'

/** @param {(request: Request, context?: { params?: Record<string, string> }) => Promise<Response>} handler */
export function withApiErrorGuard(handler) {
  return async (request, context) => {
    try {
      return await handler(request, context)
    } catch (err) {
      console.error('[vercel-api]', err)
      const msg =
        err instanceof Error ? err.message : String(err || 'Internal error')
      return new Response(JSON.stringify({ error: { message: msg } }), {
        status: 500,
        headers: {
          ...corsHeaders(),
          'Content-Type': 'application/json; charset=utf-8',
        },
      })
    }
  }
}
