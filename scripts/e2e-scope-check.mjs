const base = process.env.BASE_URL || 'http://127.0.0.1:8790'

async function req(path, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // ignore
  }
  return { status: res.status, ok: res.ok, json, text }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

async function main() {
  const studentToken = process.env.STUDENT_TOKEN || 'stu'

  // student GET must fail
  const g = await req('/api/submissions', {
    headers: { Authorization: `Bearer ${studentToken}` },
  })
  assert(!g.ok, `student GET should fail, got ${g.status}`)

  // student posts two records with different depts
  const mkRec = (dept, submittedAt) => ({
    id: `client-${Math.random().toString(16).slice(2)}`,
    submittedAt,
    student: { dept, info: 'x', subject: 's', date: '2026-04-23' },
    currentPage: 5,
    progressLabel: '보고서',
    hasCircuit: true,
    hasProcess: false,
    hasFinal: true,
    selfEval: 'A',
    swot: { s: 's', w: 'w', o: 'o', t: 't' },
    learningMinutes: 10,
    images: {},
  })

  const recA = mkRec('전기과', 1)
  const recB = mkRec('철도전기과', 2)
  const p1 = await req('/api/submissions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${studentToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: recA,
  })
  const p2 = await req('/api/submissions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${studentToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: recB,
  })
  assert(p1.ok && p1.json?.id, `student POST A failed: ${p1.status} ${p1.text}`)
  assert(p2.ok && p2.json?.id, `student POST B failed: ${p2.status} ${p2.text}`)

  const teacherLogin = async (id, password) => {
    const r = await req('/api/auth/teacher/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: { id, password },
    })
    assert(r.ok && r.json?.token, `login ${id} failed: ${r.status} ${r.text}`)
    return r.json.token
  }

  const t1 = await teacherLogin('t1', 'pw1')
  const t2 = await teacherLogin('t2', 'pw2')

  const l1 = await req('/api/submissions', {
    headers: { Authorization: `Bearer ${t1}` },
  })
  const l2 = await req('/api/submissions', {
    headers: { Authorization: `Bearer ${t2}` },
  })
  assert(Array.isArray(l1.json), `t1 list not array: ${l1.status} ${l1.text}`)
  assert(Array.isArray(l2.json), `t2 list not array: ${l2.status} ${l2.text}`)

  const depts1 = new Set(l1.json.map((r) => r?.student?.dept).filter(Boolean))
  const depts2 = new Set(l2.json.map((r) => r?.student?.dept).filter(Boolean))
  assert(!depts1.has('철도전기과'), `t1 should not see 철도전기과, got ${[...depts1]}`)
  assert(!depts2.has('전기과'), `t2 should not see 전기과, got ${[...depts2]}`)

  // t1 patch own ok
  assert(l1.json.length > 0, 't1 should see at least 1 record')
  const ownId = l1.json[0].id
  const okPatch = await req(`/api/submissions/${encodeURIComponent(ownId)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${t1}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: { teacherFeedback: 'ok' },
  })
  assert(okPatch.ok, `t1 patch own failed: ${okPatch.status} ${okPatch.text}`)

  // t1 patch other should be blocked (404)
  const otherId = p2.json.id
  const badPatch = await req(`/api/submissions/${encodeURIComponent(otherId)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${t1}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: { teacherFeedback: 'no' },
  })
  assert(badPatch.status === 404, `t1 patch other should 404, got ${badPatch.status}`)

  console.log('E2E scope check: OK')
}

main().catch((e) => {
  console.error('E2E scope check: FAIL')
  console.error(e)
  process.exit(1)
})

