/**
 * Vercel REST API 공용 클라이언트
 */
export function getToken() {
  const token = String(process.env.VERCEL_TOKEN || '').trim()
  if (!token) {
    throw new Error(
      'VERCEL_TOKEN 이 없습니다.\n' +
        '1) https://vercel.com/account/tokens 에서 토큰 발급\n' +
        '2) PowerShell: $env:VERCEL_TOKEN="토큰"\n' +
        '3) npm run vercel:kv',
    )
  }
  return token
}

/** @param {string} path @param {string} [method] @param {unknown} [body] */
export async function vercelApi(path, method = 'GET', body) {
  const token = getToken()
  const r = await fetch(`https://api.vercel.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  if (!r.ok) {
    throw new Error(`${method} ${path} (${r.status}): ${text.slice(0, 500)}`)
  }
  return text ? JSON.parse(text) : null
}

/** @param {string} [hint] */
export async function findCircuitProject(hint = 'circuit') {
  const data = await vercelApi('/v9/projects?limit=50')
  const list = data?.projects || []
  if (!list.length) throw new Error('Vercel 프로젝트가 없습니다.')

  const re = new RegExp(hint, 'i')
  const project =
    list.find((p) => /aicircuit/i.test(p.name || '')) ||
    list.find((p) => re.test(p.name || '')) ||
    list[0]

  const teamId =
    project.accountId ||
    project.teamId ||
    project.team?.id ||
    process.env.VERCEL_TEAM_ID ||
    ''

  return { project, projectId: project.id, teamId, projectName: project.name }
}
