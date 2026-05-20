/**
 * Vercel KV(배포) · 로컬 JSON 파일(개발) 공용 저장소
 */
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOCAL_KV_DIR = path.join(__dirname, 'data', 'kv')

function useVercelKv() {
  return Boolean(
    process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN,
  )
}

/** @returns {Promise<import('@vercel/kv').Kv | null>} */
async function getKv() {
  if (!useVercelKv()) return null
  const { kv } = await import('@vercel/kv')
  return kv
}

function safeKey(key) {
  return String(key || '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 200)
}

/** @param {string} key */
export async function storeGetJson(key) {
  const k = safeKey(key)
  if (!k) return null

  const kv = await getKv()
  if (kv) {
    try {
      const data = await kv.get(k)
      return data ?? null
    } catch (e) {
      console.error('[kv-store] get failed', k, e)
      return null
    }
  }

  try {
    const p = path.join(LOCAL_KV_DIR, `${k}.json`)
    const raw = await fs.readFile(p, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** @param {string} key @param {unknown} value */
export async function storeSetJson(key, value) {
  const k = safeKey(key)
  if (!k) throw new Error('Invalid storage key')

  const kv = await getKv()
  if (kv) {
    await kv.set(k, value)
    return
  }

  await fs.mkdir(LOCAL_KV_DIR, { recursive: true })
  await fs.writeFile(
    path.join(LOCAL_KV_DIR, `${k}.json`),
    JSON.stringify(value),
    'utf8',
  )
}

export function isRemoteKvConfigured() {
  return useVercelKv()
}
