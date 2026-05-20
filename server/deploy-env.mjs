/**
 * Vercel 서버리스 공통 환경 플래그
 */
export function deployEnv(extra = {}) {
  const onVercel = Boolean(process.env.VERCEL)
  return {
    ...process.env,
    ...extra,
    VERCEL: onVercel ? '1' : process.env.VERCEL || '',
    ...(onVercel
      ? {
          GEMINI_SERVERLESS_COMPACT:
            extra.GEMINI_SERVERLESS_COMPACT ??
            process.env.GEMINI_SERVERLESS_COMPACT ??
            '0',
          GEMINI_FETCH_TIMEOUT_MS:
            extra.GEMINI_FETCH_TIMEOUT_MS ??
            process.env.GEMINI_FETCH_TIMEOUT_MS ??
            '58000',
          GEMINI_PRO_ONLY:
            extra.GEMINI_PRO_ONLY ??
            process.env.GEMINI_PRO_ONLY ??
            '1',
        }
      : {}),
  }
}

/** @param {Request} [request] */
export function getSiteBaseUrl(request) {
  const vercel = String(process.env.VERCEL_URL || '').trim()
  if (vercel) return `https://${vercel.replace(/^https?:\/\//, '')}`
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
