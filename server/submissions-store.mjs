/**
 * 제출·교사 세션 저장 (Vercel KV · 로컬 JSON)
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

/** @param {unknown} [_event] 레거시 시그니처 호환 */
export function openSubmissionsStore(_event) {
  return kvCompatibleStore()
}
