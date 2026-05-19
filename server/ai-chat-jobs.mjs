/**
 * AI 채팅 백그라운드 작업 (Netlify Blobs / 로컬 파일)
 */
import * as blobs from '@netlify/blobs'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOCAL_JOBS_DIR = path.join(__dirname, 'data', 'ai-chat-jobs')
const JOB_TTL_MS = 1000 * 60 * 60

/** @returns {Promise<any>} */
async function getBlobStore() {
  return blobs.getStore({ name: 'ai-chat-jobs', consistency: 'strong' })
}

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

/** @param {string} id */
export async function readAiChatJob(id) {
  const key = jobKey(id)
  if (!id) return null

  if (process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    try {
      const store = await getBlobStore()
      const data = await store.get(key, { type: 'json' })
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

  if (process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    const store = await getBlobStore()
    await store.setJSON(key, next)
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
  const url = `${root}/.netlify/functions/openai-chat-background`
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ jobId, request: requestBody }),
  })
  if (!r.ok && r.status !== 202) {
    const t = await r.text().catch(() => '')
    throw new Error(t || `Background trigger failed (${r.status})`)
  }
}
