/**
 * 서버리스 배포(Netlify·Vercel) 공통 환경 플래그
 */
export function deployEnv(extra = {}) {
  const onVercel = Boolean(process.env.VERCEL)
  return {
    ...process.env,
    ...extra,
    NETLIFY: 'true',
    VERCEL: onVercel ? '1' : process.env.VERCEL || '',
    // Vercel: Pro 스트리밍 — 축소 모드 끄고 긴 타임아웃
    ...(onVercel
      ? {
          GEMINI_NETLIFY_FAST: extra.GEMINI_NETLIFY_FAST ?? '0',
          GEMINI_FETCH_TIMEOUT_MS:
            extra.GEMINI_FETCH_TIMEOUT_MS ??
            process.env.GEMINI_FETCH_TIMEOUT_MS ??
            '280000',
        }
      : {}),
  }
}

/** @param {Request} [request] */
export function getSiteBaseUrl(request) {
  const vercel = String(process.env.VERCEL_URL || '').trim()
  if (vercel) return `https://${vercel.replace(/^https?:\/\//, '')}`
  const url = String(process.env.URL || process.env.DEPLOY_PRIME_URL || '').trim()
  if (url) return url.replace(/\/$/, '')
  if (request) {
    try {
      const u = new URL(request.url)
      return u.origin
    } catch {
      /* ignore */
    }
  }
  return ''
}
