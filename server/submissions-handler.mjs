/**
 * 제출 동기화 API (Vercel · 로컬 공용)
 */
import { randomUUID } from 'crypto'
import { openSubmissionsStore, BLOB_SUBMISSIONS_KEY, BLOB_SESSIONS_KEY } from './submissions-store.mjs'
import { isRemoteKvConfigured } from './kv-store.mjs'

const TOKEN_ALL = (process.env.SUBMISSIONS_API_TOKEN || '').trim()
const TOKEN_STUDENT = (process.env.SUBMISSIONS_STUDENT_TOKEN || '').trim()
const TOKEN_TEACHER = (process.env.SUBMISSIONS_TEACHER_TOKEN || '').trim()
const TEACHER_PASSWORD = (
  process.env.SUBMISSIONS_TEACHER_PASSWORD ||
  process.env.VITE_TEACHER_PASSWORD ||
  ''
).trim()
const TEACHERS_JSON = (process.env.SUBMISSIONS_TEACHERS_JSON || '').trim()
const TEACHER_SESSION_TTL_MS = Math.max(
  60_000,
  Number(process.env.SUBMISSIONS_TEACHER_SESSION_TTL_MS || 1000 * 60 * 60 * 12),
)

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, If-Match',
  }
}

function readTeachersConfig() {
  if (!TEACHERS_JSON) return null
  try {
    const j = JSON.parse(TEACHERS_JSON)
    return Array.isArray(j) ? j : null
  } catch {
    return null
  }
}

/** @param {string[]} depts */
function normalizeDepts(depts) {
  const list = Array.isArray(depts) ? depts : []
  const out = list.map((x) => String(x || '').trim()).filter(Boolean)
  if (out.includes('*')) return ['*']
  return Array.from(new Set(out))
}

function deptAllowed(depts, dept) {
  const d = String(dept || '').trim()
  if (!d) return false
  if (!Array.isArray(depts) || depts.length === 0) return false
  if (depts.includes('*')) return true
  return depts.includes(d)
}

function filterByDepts(list, depts) {
  if (!Array.isArray(list)) return []
  if (!Array.isArray(depts) || depts.length === 0) return []
  if (depts.includes('*')) return list
  return list.filter((r) => deptAllowed(depts, r?.student?.dept))
}

/** @param {any} store */
async function readList(store) {
  const data = await store.get(BLOB_SUBMISSIONS_KEY, { type: 'json' })
  return Array.isArray(data) ? data : []
}

/** @param {any} store @param {unknown[]} list */
async function writeList(store, list) {
  await store.setJSON(BLOB_SUBMISSIONS_KEY, list)
}

/** @param {any} store */
async function readSessions(store) {
  const data = await store.get(BLOB_SESSIONS_KEY, { type: 'json' })
  return data && typeof data === 'object' ? data : {}
}

/** @param {any} store @param {Record<string, unknown>} obj */
async function writeSessions(store, obj) {
  await store.setJSON(BLOB_SESSIONS_KEY, obj)
}

/** @param {string} h */
function bearer(h) {
  const s = String(h || '').trim()
  if (!s.startsWith('Bearer ')) return ''
  return s.slice('Bearer '.length).trim()
}

function authRole(authz) {
  const b = bearer(authz)
  if (!b) return 'none'
  if (TOKEN_ALL && b === TOKEN_ALL) return 'all'
  if (TOKEN_TEACHER && b === TOKEN_TEACHER) return 'teacher'
  if (TOKEN_STUDENT && b === TOKEN_STUDENT) return 'student'
  return 'none'
}

/** @param {any} store @param {string} authz */
async function sessionContext(store, authz) {
  const token = bearer(authz)
  if (!token) return { role: 'none' }
  const sessions = await readSessions(store)
  const raw = sessions?.[token]
  const exp = typeof raw === 'number' ? raw : Number(raw?.exp || 0)
  if (!exp || !Number.isFinite(exp)) return { role: 'none' }
  if (Date.now() > exp) return { role: 'none' }
  const teacherId = raw && typeof raw === 'object' ? String(raw.teacherId || '') : ''
  const depts = raw && typeof raw === 'object' ? normalizeDepts(raw.depts) : []
  return { role: 'teacher', teacherId: teacherId || undefined, depts }
}

function requireStudentOrTeacher(authz) {
  if (!TOKEN_ALL && !TOKEN_STUDENT && !TOKEN_TEACHER) return true
  const r = authRole(authz)
  return r === 'student' || r === 'teacher' || r === 'all'
}

/** @param {any} store @param {string} authz */
async function requireTeacher(store, authz) {
  if (!TOKEN_ALL && !TOKEN_STUDENT && !TOKEN_TEACHER && !TEACHER_PASSWORD && !TEACHERS_JSON) {
    return { depts: ['*'] }
  }
  let r = authRole(authz)
  if (r === 'all') return { depts: ['*'] }
  if (r === 'teacher') return { depts: ['*'] }

  const sc = await sessionContext(store, authz)
  if (sc.role === 'teacher') {
    return { teacherId: sc.teacherId, depts: sc.depts || [] }
  }
  return null
}

function isStudentOnly(authz) {
  if (!TOKEN_ALL && !TOKEN_STUDENT && !TOKEN_TEACHER) return false
  return authRole(authz) === 'student'
}

function normalizeRecord(incoming, existing = null) {
  const now = Date.now()
  const prev = existing && typeof existing === 'object' ? existing : {}
  const inc = incoming && typeof incoming === 'object' ? incoming : {}

  const teacherFeedback =
    inc.teacherFeedback !== undefined ? inc.teacherFeedback : prev.teacherFeedback
  const feedbackUpdatedAt =
    inc.feedbackUpdatedAt !== undefined ? inc.feedbackUpdatedAt : prev.feedbackUpdatedAt

  const merged = {
    ...prev,
    ...inc,
    teacherFeedback,
    feedbackUpdatedAt,
  }
  const prevVer = Number(prev.version || 0)
  merged.version = prevVer + 1
  merged.updatedAt = now
  if (!merged.createdAt) merged.createdAt = now
  return merged
}

function parseWeakEtag(v) {
  if (!v) return null
  const s = String(v).trim()
  if (!s.startsWith('W/"') || !s.endsWith('"')) return null
  const inner = s.slice(3, -1)
  const n = Number(inner)
  return Number.isFinite(n) ? n : null
}

function json(status, data, extra = {}) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
      ...extra,
    },
    body: typeof data === 'string' ? data : JSON.stringify(data),
  }
}

function text(status, msg) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders() },
    body: msg,
  }
}

function empty(status) {
  return { statusCode: status, headers: { ...corsHeaders() }, body: '' }
}

/** @param {any} store @param {any} event */
async function handleAuthLogin(store, event) {
  const teachers = readTeachersConfig()
  const hasMulti = Array.isArray(teachers) && teachers.length > 0
  if (!TEACHER_PASSWORD && !hasMulti) {
    return text(400, 'Teacher password is not configured on server')
  }
  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return text(400, 'Invalid JSON')
  }
  const id = body && typeof body === 'object' ? String(body.id || '').trim() : ''
  const pw = body && typeof body === 'object' ? String(body.password || '') : ''

  /** @type {{ teacherId?: string, depts?: string[] } | null} */
  let teacher = null
  if (hasMulti) {
    const hit = teachers.find((t) => t && String(t.id || '').trim() === id)
    if (hit && String(hit.password || '') === pw) {
      teacher = {
        teacherId: String(hit.id || '').trim(),
        depts: normalizeDepts(hit.depts),
      }
    }
  } else if (pw === TEACHER_PASSWORD) {
    teacher = { teacherId: id || 'teacher', depts: ['*'] }
  }

  if (!teacher) return text(401, 'Unauthorized')

  const token = randomUUID()
  const expiresAt = Date.now() + TEACHER_SESSION_TTL_MS
  const sessions = await readSessions(store)
  const now = Date.now()
  for (const k of Object.keys(sessions)) {
    const v = sessions[k]
    const e = typeof v === 'number' ? v : Number(v?.exp || 0)
    if (!e || e < now) delete sessions[k]
  }
  sessions[token] = {
    exp: expiresAt,
    teacherId: teacher.teacherId,
    depts: teacher.depts || [],
  }
  await writeSessions(store, sessions)

  return json(200, {
    token,
    expiresAt,
    teacherId: teacher.teacherId,
    depts: teacher.depts || [],
  })
}

/** @param {any} store @param {any} event */
async function handleListRoot(store, event) {
  const authz = event.headers?.authorization || event.headers?.Authorization || ''

  if (event.httpMethod === 'GET') {
    const ctx = await requireTeacher(store, authz)
    if (!ctx) return text(401, 'Unauthorized')
    const list = await readList(store)
    return json(200, filterByDepts(list, ctx.depts || []))
  }

  if (event.httpMethod === 'POST') {
    if (!requireStudentOrTeacher(authz)) return text(401, 'Unauthorized')
    let body
    try {
      body = JSON.parse(event.body || '{}')
    } catch {
      return text(400, 'Invalid JSON')
    }
    if (!body || typeof body !== 'object') return text(400, 'Body must be an object')

    const incoming = { ...body }
    if (isStudentOnly(authz)) {
      incoming.id = randomUUID()
      delete incoming.teacherFeedback
      delete incoming.feedbackUpdatedAt
      delete incoming.version
      delete incoming.updatedAt
      delete incoming.createdAt
    } else if (!incoming.id) {
      return text(400, 'Missing id')
    }

    const id = String(incoming.id)
    const list = await readList(store)
    const idx = list.findIndex((x) => x && String(x.id) === id)
    const prev = idx >= 0 ? list[idx] : null
    const next = normalizeRecord(incoming, prev)
    if (idx >= 0) list[idx] = next
    else list.push(next)
    list.sort((a, b) => Number(b.submittedAt || 0) - Number(a.submittedAt || 0))
    await writeList(store, list)
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        ETag: `W/"${next.version}"`,
        ...corsHeaders(),
      },
      body: JSON.stringify(next),
    }
  }

  return text(405, 'Method Not Allowed')
}

/** @param {any} store @param {any} event @param {string} id */
async function handleRecordById(store, event, id) {
  const authz = event.headers?.authorization || event.headers?.Authorization || ''

  if (event.httpMethod === 'DELETE') {
    const ctx = await requireTeacher(store, authz)
    if (!ctx) return text(401, 'Unauthorized')
    const list = await readList(store)
    const hit = list.find((x) => x && String(x.id) === String(id))
    if (hit && !deptAllowed(ctx.depts || [], hit?.student?.dept)) return text(403, 'Forbidden')
    const next = list.filter((x) => !(x && String(x.id) === String(id)))
    await writeList(store, next)
    return empty(204)
  }

  if (event.httpMethod === 'PATCH') {
    const ctx = await requireTeacher(store, authz)
    if (!ctx) return text(401, 'Unauthorized')
    let patch
    try {
      patch = JSON.parse(event.body || '{}')
    } catch {
      return text(400, 'Invalid JSON')
    }
    if (!patch || typeof patch !== 'object') return text(400, 'Body must be an object')

    const ifMatch = parseWeakEtag(event.headers?.['if-match'] || event.headers?.['If-Match'] || '')
    const list = await readList(store)
    const idx = list.findIndex((x) => x && String(x.id) === String(id))
    if (idx < 0) return text(404, 'Not found')
    const prev = list[idx]
    if (!deptAllowed(ctx.depts || [], prev?.student?.dept)) return text(404, 'Not found')
    const prevVer = Number(prev?.version || 0)
    if (ifMatch !== null && prevVer !== ifMatch) {
      return json(409, { message: 'Version conflict', current: prev })
    }
    const next = normalizeRecord(patch, prev)
    list[idx] = next
    await writeList(store, list)
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        ETag: `W/"${next.version}"`,
        ...corsHeaders(),
      },
      body: JSON.stringify(next),
    }
  }

  return text(405, 'Method Not Allowed')
}

/** @param {any} store @param {any} event @param {string} id */
async function handleStatus(store, event, id) {
  const authz = event.headers?.authorization || event.headers?.Authorization || ''
  if (event.httpMethod !== 'GET') return text(405, 'Method Not Allowed')
  if (!requireStudentOrTeacher(authz)) return text(401, 'Unauthorized')

  const list = await readList(store)
  const hit = list.find((x) => x && String(x.id) === String(id)) || null
  if (!hit) return text(404, 'Not found')

  const r = authRole(authz)
  if (r === 'teacher' || r === 'all') {
    // ok
  } else {
    const sc = await sessionContext(store, authz)
    if (sc?.role === 'teacher') {
      const depts = Array.isArray(sc.depts) ? sc.depts : []
      if (!deptAllowed(depts, hit?.student?.dept)) return text(404, 'Not found')
    }
  }

  const teacherFeedback = String(hit?.teacherFeedback || '').trim()
  const feedbackUpdatedAt = Number(hit?.feedbackUpdatedAt || 0)
  return json(200, {
    id: String(hit.id),
    feedbackReady: Boolean(teacherFeedback),
    feedbackUpdatedAt:
      Number.isFinite(feedbackUpdatedAt) && feedbackUpdatedAt > 0 ? feedbackUpdatedAt : null,
  })
}

/** @param {any} event @returns {{ mode: string, rid: string }} */
function parseRoute(event) {
  const qs = event.queryStringParameters || {}
  let mode = String(qs.mode || '')
  let rid = String(qs.rid || event.pathParameters?.id || '').trim()
  if (
    mode === 'list' ||
    mode === 'auth' ||
    (mode === 'status' && rid) ||
    (mode === 'record' && rid)
  ) {
    return { mode, rid }
  }

  const headers = event.headers || {}
  const hget = (/** @type {string} */ a, /** @type {string} */ b) =>
    headers[a] || headers[b] || ''
  const forwarded =
    hget('x-forwarded-uri', 'X-Forwarded-Uri') ||
    hget('x-invoke-path', 'X-Invoke-Path') ||
    ''

  const rawUrl = typeof event.rawUrl === 'string' ? event.rawUrl : ''
  const candidatePaths = []
  if (forwarded) candidatePaths.push(String(forwarded).split('?')[0])
  const rcPath = event.requestContext?.http?.path || event.requestContext?.path
  if (rcPath) candidatePaths.push(String(rcPath).split('?')[0])
  if (event.path) candidatePaths.push(String(event.path).split('?')[0])
  if (rawUrl) {
    try {
      const u = new URL(rawUrl)
      const qm = u.searchParams.get('mode')
      const qr = u.searchParams.get('rid') || ''
      if (qm) return { mode: String(qm), rid: String(qr).trim() }
      candidatePaths.push(u.pathname)
    } catch {
      /* ignore */
    }
  }

  for (const rawPath of candidatePaths) {
    const p = String(rawPath || '').split('?')[0]
    if (!p) continue

    if (p === '/api/submissions' || p === '/api/submissions/') return { mode: 'list', rid: '' }
    if (p === '/api/auth/teacher/login') return { mode: 'auth', rid: '' }

    const st = p.match(/^\/api\/submissions\/([^/]+)\/status\/?$/i)
    if (st) {
      try {
        return { mode: 'status', rid: decodeURIComponent(st[1]) }
      } catch {
        return { mode: 'status', rid: st[1] }
      }
    }

    const rec = p.match(/^\/api\/submissions\/([^/]+)\/?$/i)
    if (rec) {
      try {
        return { mode: 'record', rid: decodeURIComponent(rec[1]) }
      } catch {
        return { mode: 'record', rid: rec[1] }
      }
    }
  }

  return { mode: '', rid: '' }
}

/** @param {any} event */
export async function handleSubmissionsEvent(event) {
  const headers = corsHeaders()
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' }
  }

  let store
  try {
    store = await openSubmissionsStore(event)
  } catch (e) {
    console.error('[submissions-handler] store open failed', e)
    return text(503, 'Submission store unavailable.')
  }

  if (!store) {
    return text(503, 'Submission store unavailable.')
  }

  if (process.env.VERCEL === '1' && !isRemoteKvConfigured()) {
    return text(
      503,
      'Vercel KV is not configured. Create a KV database in the Vercel project and link it (KV_REST_API_URL).',
    )
  }

  const { mode, rid } = parseRoute(event)

  try {
    if (mode === 'auth') return await handleAuthLogin(store, event)
    if (mode === 'status' && rid) return await handleStatus(store, event, rid)
    if (mode === 'record' && rid) return await handleRecordById(store, event, rid)
    if (mode === 'list') return await handleListRoot(store, event)
    return text(404, 'Not found')
  } catch (e) {
    console.error('[submissions-handler]', e)
    return text(500, e instanceof Error ? e.message : 'error')
  }
}
