/** 배포·환경 변수 확인 */
export const config = {
  maxDuration: 10,
}

export default function handler(req, res) {
  res.statusCode = 200
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(
    JSON.stringify({
      ok: true,
      vercel: Boolean(process.env.VERCEL),
      kv: Boolean(process.env.KV_REST_API_URL),
      gemini: Boolean(process.env.GEMINI_API_KEY),
    }),
  )
}
