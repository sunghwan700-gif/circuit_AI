/**
 * Vercel Production 재배포 (환경 변수 변경 후)
 * VERCEL_TOKEN, VERCEL_PROJECT_ID (선택, 없으면 circuit 이름 프로젝트)
 */
const token = process.env.VERCEL_TOKEN
if (!token) {
  console.error('VERCEL_TOKEN 필요')
  process.exit(1)
}

async function api(path, method, body) {
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
    throw new Error(`${method} ${path} (${r.status}): ${text.slice(0, 400)}`)
  }
  return text ? JSON.parse(text) : null
}

async function main() {
  let projectId = String(process.env.VERCEL_PROJECT_ID || '').trim()
  let projectName = ''

  if (!projectId) {
    const projects = await api('/v9/projects?limit=20', 'GET')
    const list = projects?.projects || []
    const project =
      list.find((p) => /circuit/i.test(p.name || '')) || list[0]
    if (!project) throw new Error('Vercel 프로젝트 없음')
    projectId = project.id
    projectName = project.name
  }

  const deps = await api(
    `/v6/deployments?projectId=${projectId}&limit=1&target=production`,
    'GET',
  )
  const last = deps?.deployments?.[0]
  if (!last?.uid) {
    console.log('최근 배포 없음 — Vercel 대시보드에서 Redeploy 하세요.')
    return
  }

  const redeploy = await api(`/v13/deployments`, 'POST', {
    deploymentId: last.uid,
    name: projectName || last.name,
    project: projectId,
    target: 'production',
  })
  console.log('재배포 요청:', redeploy?.url || redeploy?.id || 'ok')
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
