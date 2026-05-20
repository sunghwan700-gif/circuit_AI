/**
 * 로컬 .env → Vercel Production 환경 변수 업로드
 * 사용: npx vercel login 후
 *   node scripts/push-vercel-env.mjs
 *
 * 필요: VERCEL_TOKEN (또는 vercel login 세션)
 */
import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

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

async function vercelApi(path, method, body) {
  const token = process.env.VERCEL_TOKEN
  if (!token) {
    throw new Error(
      'VERCEL_TOKEN 이 없습니다. Vercel → Settings → Tokens 에서 발급 후 환경 변수로 설정하세요.',
    )
  }
  const r = await fetch(`https://api.vercel.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  if (!r.ok) {
    throw new Error(`${method} ${path} failed (${r.status}): ${text.slice(0, 400)}`)
  }
  return text ? JSON.parse(text) : null
}

function loadEnvValues() {
  const parsed = existsSync(ENV_FILE)
    ? parseDotEnv(readFileSync(ENV_FILE, 'utf8'))
    : {}
  for (const key of KEYS) {
    const fromProcess = String(process.env[key] || '').trim()
    if (fromProcess) parsed[key] = fromProcess
  }
  return parsed
}

async function main() {
  const parsed = loadEnvValues()
  if (!KEYS.some((k) => String(parsed[k] || '').trim())) {
    console.error(
      '.env 또는 환경 변수(GEMINI_API_KEY 등)에 값이 없습니다.',
    )
    process.exit(1)
  }

  const projects = await vercelApi('/v9/projects?limit=20', 'GET')
  const list = projects?.projects || []
  if (!list.length) {
    throw new Error('Vercel 프로젝트를 찾지 못했습니다.')
  }

  const nameHint = process.env.VERCEL_PROJECT_NAME || 'circuit'
  let project =
    list.find((p) => /circuit/i.test(p.name || '')) ||
    list.find((p) => /circuit-ai/i.test(p.name || '')) ||
    list[0]

  const projectId = project.id
  console.log(`Project: ${project.name} (${projectId})`)

  for (const key of KEYS) {
    const value = String(parsed[key] || '').trim()
    if (!value) {
      console.log(`skip (empty): ${key}`)
      continue
    }
    await vercelApi(
      `/v10/projects/${projectId}/env?upsert=true`,
      'POST',
      {
        key,
        value,
        type: 'encrypted',
        target: ['production', 'preview', 'development'],
      },
    )
    console.log(`ok: ${key}`)
  }

  console.log('\n완료. Vercel 대시보드에서 Redeploy 하세요.')
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
