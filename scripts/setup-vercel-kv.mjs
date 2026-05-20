/**
 * Vercel 프로젝트에 Upstash Redis(KV) 연결 + 재배포
 *
 * PowerShell:
 *   $env:VERCEL_TOKEN="발급한_토큰"
 *   npm run vercel:kv
 */
import { spawnSync } from 'child_process'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'
import { findCircuitProject, getToken, vercelApi } from './vercel-api.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STORE_NAME = process.env.VERCEL_KV_NAME || 'circuit-submissions-kv'
const VERCEL_CLI = 'vercel@latest'

function loadTokenFromAuthFile() {
  if (process.env.VERCEL_TOKEN) return
  const paths = [
    resolve(ROOT, '.vercel', 'auth.json'),
    resolve(homedir(), '.vercel', 'auth.json'),
  ]
  for (const p of paths) {
    if (!existsSync(p)) continue
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'))
      const t = j.token || j.credentials?.[0]?.token
      if (t) {
        process.env.VERCEL_TOKEN = String(t).trim()
        return
      }
    } catch {
      /* ignore */
    }
  }
}

function runVercelCli(args, { inherit = true } = {}) {
  const token = getToken()
  const bin = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const r = spawnSync(bin, ['-y', VERCEL_CLI, ...args, '-t', token], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : 'pipe',
    shell: process.platform === 'win32',
    env: { ...process.env, VERCEL_TOKEN: token },
  })
  return {
    status: r.status ?? 1,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  }
}

/** @param {string} projectId @param {string} teamId */
async function listStores(projectId, teamId) {
  const q = new URLSearchParams({ projectId })
  if (teamId) q.set('teamId', teamId)
  try {
    const data = await vercelApi(`/v1/storage/stores?${q}`, 'GET')
    return data?.stores || []
  } catch {
    return []
  }
}

/** @param {object[]} stores */
function hasKvStore(stores) {
  return stores.some((s) => {
    const t = String(s.type || s.provider || s.name || '').toLowerCase()
    return /redis|kv|upstash/.test(t)
  })
}

/** @param {string} projectId */
async function envHasKv(projectId) {
  const data = await vercelApi(`/v9/projects/${projectId}/env`, 'GET')
  const envs = data?.envs || data?.env || []
  return envs.some((e) =>
    ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL'].includes(
      e.key,
    ),
  )
}

/** @param {string} projectName @param {string} teamId */
async function installUpstashKv(projectName, teamId) {
  const scope = teamId ? ['-S', teamId] : []
  const regions = ['hnd1', 'sin1', 'icn1', 'iad1']

  runVercelCli(['link', '-p', projectName, '-y', ...scope])

  for (const region of regions) {
    console.log(`\n▶ Upstash KV 설치 (region=${region})…`)
    const r = runVercelCli(
      [
        'integration',
        'add',
        'upstash/upstash-kv',
        '-n',
        STORE_NAME,
        '-m',
        `primaryRegion=${region}`,
        '--non-interactive',
        ...scope,
      ],
      { inherit: true },
    )
    if (r.status === 0) return true
  }

  console.log('\n▶ integration add upstash (자동 선택)…')
  const fallback = runVercelCli(
    ['integration', 'add', 'upstash', '--non-interactive', ...scope],
    { inherit: true },
  )
  return fallback.status === 0
}

async function pullEnvToProject() {
  console.log('\n▶ 환경 변수 동기화 (env pull)…')
  const r = runVercelCli(
    ['env', 'pull', '.env.vercel.kv', '--yes', '--environment', 'production'],
    { inherit: false },
  )
  if (r.status !== 0) return false
  const outPath = resolve(ROOT, '.env.vercel.kv')
  if (!existsSync(outPath)) return false
  return true
}

async function main() {
  loadTokenFromAuthFile()
  const { projectId, teamId, projectName } = await findCircuitProject(
    process.env.VERCEL_PROJECT_NAME || 'aicircuit',
  )
  console.log(`대상 프로젝트: ${projectName} (${projectId})`)
  if (teamId) console.log(`Team: ${teamId}`)

  mkdirSync(resolve(ROOT, '.vercel'), { recursive: true })
  writeFileSync(
    resolve(ROOT, '.vercel/project.json'),
    JSON.stringify({ projectId, orgId: teamId || projectId }),
  )

  let hasKv = await envHasKv(projectId)
  const stores = await listStores(projectId, teamId)

  if (!hasKv && !hasKvStore(stores)) {
    const ok = await installUpstashKv(projectName, teamId)
    if (!ok) {
      console.warn('\nCLI 설치가 완료되지 않았습니다.')
    }
    await pullEnvToProject()
    hasKv = await envHasKv(projectId)
  } else {
    console.log('KV/Redis 스토어 또는 환경 변수가 이미 있습니다.')
  }

  if (!hasKv) {
    console.warn('\n⚠ KV_REST_API_URL 이 아직 없습니다.')
    console.warn('다음 중 하나를 시도하세요:')
    console.warn('  1) Vercel → aicircuit → Storage → Upstash Redis → Connect')
    console.warn(
      '  2) https://console.upstash.com 에서 DB 생성 후 .env 에 URL/TOKEN → npm run vercel:env',
    )
  } else {
    console.log('\n✓ KV 환경 변수 확인됨')
  }

  console.log('\n▶ .env → Vercel 환경 변수 업로드…')
  spawnSync('node', ['scripts/push-vercel-env.mjs'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  })

  console.log('\n▶ 재배포…')
  spawnSync('node', ['scripts/trigger-vercel-deploy.mjs'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  })

  console.log('\n확인: https://aicircuit.vercel.app/api/ping')
  console.log('  "kv": true 이면 제출·교사 대시보드가 동작합니다.')
}

main().catch((e) => {
  console.error('\n', e instanceof Error ? e.message : e)
  process.exit(1)
})
