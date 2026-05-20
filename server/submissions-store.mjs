/**
 * 제출·교사 세션 저장 (Vercel KV · Netlify Blobs · 로컬 파일)
 */
import { storeGetJson, storeSetJson } from './kv-store.mjs'

export const BLOB_SUBMISSIONS_KEY = 'submissions-list-v1'
export const BLOB_SESSIONS_KEY = 'teacher-sessions-v1'

function kvCompatibleStore() {
  return {
    /** @param {string} key @param {{ type?: string }} [opts] */
    async get(key, opts) {
      if (opts?.type !== 'json') return null
      const data = await storeGetJson(key)
      if (key === BLOB_SUBMISSIONS_KEY) return Array.isArray(data) ? data : []
      if (key === BLOB_SESSIONS_KEY) {
        return data && typeof data === 'object' ? data : {}
      }
      return data
    },
    /** @param {string} key @param {unknown} value */
    async setJSON(key, value) {
      await storeSetJson(key, value)
    },
  }
}

/** @param {any} [event] Netlify Lambda event (Blobs 연결용) */
async function netlifyBlobStore(event) {
  const blobs = await import('@netlify/blobs')
  if (typeof blobs.connectLambda === 'function' && event) {
    blobs.connectLambda(event)
  }
  let store
  try {
    store = blobs.getStore({ name: 'circuit-journal-submissions' })
  } catch {
    store = blobs.getStore('circuit-journal-submissions')
  }
  return store
}

/** @param {any} [event] */
export function openSubmissionsStore(event) {
  if (process.env.KV_REST_API_URL) {
    return kvCompatibleStore()
  }
  if (
    process.env.NETLIFY === 'true' ||
    Boolean(process.env.NETLIFY_BLOBS_CONTEXT)
  ) {
    return netlifyBlobStore(event)
  }
  return kvCompatibleStore()
}
