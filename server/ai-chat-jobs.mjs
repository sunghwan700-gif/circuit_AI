/**
 * AI 채팅 백그라운드 작업 (Vercel KV / 로컬 파일)
 */
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import { storeGetJson, storeSetJson } from './kv-store.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOCAL_JOBS_DIR = path.join(__dirname, 'data', 'ai-chat-jobs')
const JOB_TTL_MS = 1000 * 60 * 60

function jobKey(id) {
  return `job-${String(id).trim()}`
}

/** @param {unknown} job */
function normalizeJob(job) {
  if (!job || typeof job !== 'object') return null
  const j = /** @type {Record<string, unknown>} */ (job)
  const createdAt = Number(j.createdAt || 0)
  if (createdAt && Date.now() - createdAt > JOB_TTL_MS) return null
  return job
}

function useRemoteKv() {
  return Boolean(process.env.KV_REST_API_URL)
}

/** @param {string} id */
export async function readAiChatJob(id) {
  const key = jobKey(id)
  if (!id) return null

  if (useRemoteKv()) {
    try {
      const data = await storeGetJson(key)
      return normalizeJob(data)
    } catch {
      return null
    }
  }

  try {
    const p = path.join(LOCAL_JOBS_DIR, `${id}.json`)
    const raw = await fs.readFile(p, 'utf8')
    return normalizeJob(JSON.parse(raw))
  } catch {
    return null
  }
}

/** @param {string} id @param {Record<string, unknown>} patch */
export async function writeAiChatJob(id, patch) {
  const key = jobKey(id)
  const prev = (await readAiChatJob(id)) || {}
  const next = {
    ...prev,
    ...patch,
    id,
    updatedAt: Date.now(),
  }

  if (useRemoteKv()) {
    await storeSetJson(key, next)
    return next
  }

  await fs.mkdir(LOCAL_JOBS_DIR, { recursive: true })
  await fs.writeFile(
    path.join(LOCAL_JOBS_DIR, `${id}.json`),
    JSON.stringify(next),
    'utf8',
  )
  return next
}

/** @param {Record<string, unknown>} requestBody */
export async function createPendingAiChatJob(requestBody) {
  const id = randomUUID()
  await writeAiChatJob(id, {
    status: 'pending',
    createdAt: Date.now(),
    message: 'Pro 분석 대기 중…',
    request: requestBody,
  })
  return id
}

export function newJobId() {
  return randomUUID()
}

/** @param {string} baseUrl @param {string} jobId @param {object} requestBody */
export async function triggerAiChatBackground(baseUrl, jobId, requestBody) {
  const root = String(baseUrl || '').replace(/\/$/, '')
  const payload = JSON.stringify({ jobId, request: requestBody })
  const url = `${root}/api/openai/chat/background`
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: payload,
    })
    if (r.ok || r.status === 202) return
    const lastErr = await r.text().catch(() => '')
    throw new Error(lastErr || 'Background trigger failed')
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e))
  }
}
