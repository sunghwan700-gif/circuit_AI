/** 배포·라우팅 확인용 (server/ 미사용) */
export const config = {
  runtime: 'nodejs',
}

export default function handler() {
  return Response.json({
    ok: true,
    vercel: Boolean(process.env.VERCEL),
    kv: Boolean(process.env.KV_REST_API_URL),
    gemini: Boolean(process.env.GEMINI_API_KEY),
  })
}
