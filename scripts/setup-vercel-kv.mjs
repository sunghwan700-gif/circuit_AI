/**
 * Vercel 프로젝트에 Upstash Redis(KV) 연결 + 재배포
 *
 * PowerShell:
 *   $env:VERCEL_TOKEN="발급한_토큰"
 *   npm run vercel:kv
 */
import { spawnSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { findCircuitProject, getToken, vercelApi } from './vercel-api.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STORE_NAME = process.env.VERCEL_KV_NAME || 'circuit-submissions-kv'

function runVercelCli(args) {
  const token = getToken()
  const r = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['-y', 'vercel@41', ...args, '-t', token],
    {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, VERCEL_TOKEN: token },
    },
  )
  return r.status ?? 1
}

/** @param {string} projectId @param {string} teamId */
async function listStores(projectId, teamId) {
  const q = new URLSearchParams({ projectId })
  if (teamId) q.set('teamId', teamId)
  try {
    const data = await vercelApi(`/v1/storage/stores?${q}`, 'GET')
    return data?.stores || []
  } catch (e) {
    console.warn('storage 목록 조회 실패:', e instanceof Error ? e.message : e)
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

/** @param {string} projectId @param {string} teamId */
async function tryCreateRedisApi(projectId, teamId) {
  const regions = ['icn1', 'sin1', 'hnd1', 'iad1']
  for (const region of regions) {
    try {
      const q = teamId ? `?teamId=${encodeURIComponent(teamId)}` : ''
      const data = await vercelApi(`/v1/storage/stores/redis${q}`, 'POST', {
        name: STORE_NAME,
        eviction: true,
        primaryRegion: region,
        readRegions: [],
      })
      const store = data?.store || data
      if (store?.id) {
        console.log(`Redis 생성됨 (${region}):`, store.id)
        return store
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!/region|invalid|not supported/i.test(msg)) {
        console.warn(`redis 생성 ${region} 실패:`, msg.slice(0, 200))
      }
    }
  }
  return null
}

/** @param {string} storeId @param {string} projectId @param {string} teamId */
async function tryConnectStore(storeId, projectId, teamId) {
  const attempts = [
    () => {
      const q = teamId ? `?teamId=${encodeURIComponent(teamId)}` : ''
      return vercelApi(
        `/v1/storage/stores/${storeId}/connect${q}`,
        'POST',
        { projectId },
      )
    },
    () => {
      const q = teamId ? `?teamId=${encodeURIComponent(teamId)}` : ''
      return vercelApi(
        `/v1/storage/stores/${storeId}/links${q}`,
        'POST',
        { projectId },
      )
    },
  ]
  for (const fn of attempts) {
    try {
      await fn()
      return true
    } catch {
      /* try next */
    }
  }
  return false
}

async function tryCliInstall(projectName, teamId) {
  const scope = teamId ? ['-S', teamId] : []
  const linkArgs = ['link', '-p', projectName, '-y', ...scope]
  console.log('\n프로젝트 연결:', linkArgs.join(' '))
  runVercelCli(linkArgs)

  const products = [
    ['install', 'upstash-kv', '--name', STORE_NAME, '-y'],
    ['install', 'upstash/redis', '--name', STORE_NAME, '-y'],
    ['integration', 'add', 'upstash-kv', '--name', STORE_NAME, '-y'],
    ['integration', 'add', 'upstash/redis', '--name', STORE_NAME, '-y'],
    ['install', 'upstash', '--name', STORE_NAME, '-y'],
  ]

  for (const args of products) {
    console.log('\n시도:', args.join(' '))
    const code = runVercelCli([...args, ...scope])
    if (code === 0) return true
  }
  return false
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

async function main() {
  const { project, projectId, teamId, projectName } = await findCircuitProject(
    process.env.VERCEL_PROJECT_NAME || 'circuit',
  )
  console.log(`대상 프로젝트: ${projectName} (${projectId})`)
  if (teamId) console.log(`Team/Account: ${teamId}`)

  mkdirSync(resolve(ROOT, '.vercel'), { recursive: true })
  writeFileSync(
    resolve(ROOT, '.vercel/project.json'),
    JSON.stringify({ projectId, orgId: teamId || projectId }),
  )

  let stores = await listStores(projectId, teamId)
  if (hasKvStore(stores)) {
    console.log('이미 Redis/KV 스토어가 연결되어 있습니다.')
  } else {
    let created = await tryCreateRedisApi(projectId, teamId)
    if (created?.id) {
      await tryConnectStore(created.id, projectId, teamId)
    }
    stores = await listStores(projectId, teamId)
    if (!hasKvStore(stores)) {
      console.log('\nAPI로 생성되지 않아 CLI 설치를 시도합니다…')
      await tryCliInstall(projectName, teamId)
      stores = await listStores(projectId, teamId)
    }
  }

  const hasEnv = await envHasKv(projectId)
  if (!hasEnv) {
    console.warn(
      '\n경고: 프로젝트 환경 변수에 KV_REST_API_URL 이 아직 없습니다.',
    )
    console.warn(
      'Vercel 대시보드 → Storage → 생성한 DB → Connect to Project → aicircuit 선택',
    )
    console.warn(
      '또는 Upstash 콘솔에서 REST URL/TOKEN 을 .env 에 넣고 npm run vercel:env 실행',
    )
  } else {
    console.log('\n환경 변수 KV_* 확인됨.')
  }

  console.log('\n재배포 중…')
  const dep = spawnSync('node', ['scripts/trigger-vercel-deploy.mjs'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  })
  if ((dep.status ?? 1) !== 0) {
    console.log('재배포 스크립트 실패 — Vercel 대시보드에서 Redeploy 해 주세요.')
  }

  console.log('\n완료 후 확인: https://aicircuit.vercel.app/api/ping')
  console.log('  "kv": true 이면 제출·대시보드가 동작합니다.')
}

main().catch((e) => {
  console.error('\n', e instanceof Error ? e.message : e)
  process.exit(1)
})
