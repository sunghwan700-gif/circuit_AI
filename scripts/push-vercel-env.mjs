/**
 * 로컬 .env → Vercel Production 환경 변수 업로드
 * PowerShell:
 *   $env:VERCEL_TOKEN="토큰"
 *   npm run vercel:env
 */
import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { findCircuitProject, vercelApi } from './vercel-api.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENV_FILE = resolve(ROOT, '.env')

const KEYS = [
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
  'GEMINI_CHAT_MODEL',
  'GEMINI_FALLBACK_MODELS',
  'GEMINI_FETCH_TIMEOUT_MS',
  'SUBMISSIONS_STUDENT_TOKEN',
  'SUBMISSIONS_TEACHER_PASSWORD',
  'VITE_SUBMISSIONS_STUDENT_TOKEN',
  'VITE_GEMINI_CHAT_MODEL',
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
  'KV_REST_API_READ_ONLY_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
]

function parseDotEnv(raw) {
  const out = {}
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i < 1) continue
    const k = t.slice(0, i).trim()
    let v = t.slice(i + 1).trim()
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1)
    }
    out[k] = v
  }
  return out
}

function loadEnvValues() {
  const parsed = existsSync(ENV_FILE)
    ? parseDotEnv(readFileSync(ENV_FILE, 'utf8'))
    : {}
  for (const key of KEYS) {
    const fromProcess = String(process.env[key] || '').trim()
    if (fromProcess) parsed[key] = fromProcess
  }
  if (!parsed.KV_REST_API_URL && parsed.UPSTASH_REDIS_REST_URL) {
    parsed.KV_REST_API_URL = parsed.UPSTASH_REDIS_REST_URL
  }
  if (!parsed.KV_REST_API_TOKEN && parsed.UPSTASH_REDIS_REST_TOKEN) {
    parsed.KV_REST_API_TOKEN = parsed.UPSTASH_REDIS_REST_TOKEN
  }
  return parsed
}

async function main() {
  const parsed = loadEnvValues()
  if (!KEYS.some((k) => String(parsed[k] || '').trim())) {
    console.error('.env 또는 환경 변수에 업로드할 값이 없습니다.')
    process.exit(1)
  }

  const { projectId, projectName } = await findCircuitProject()
  console.log(`Project: ${projectName} (${projectId})`)

  for (const key of KEYS) {
    const value = String(parsed[key] || '').trim()
    if (!value) {
      console.log(`skip (empty): ${key}`)
      continue
    }
    await vercelApi(`/v10/projects/${projectId}/env?upsert=true`, 'POST', {
      key,
      value,
      type: 'encrypted',
      target: ['production', 'preview', 'development'],
    })
    console.log(`ok: ${key}`)
  }

  console.log('\n완료. npm run vercel:kv 또는 Vercel에서 Redeploy 하세요.')
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
