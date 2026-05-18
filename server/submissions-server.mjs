/**
 * 교사 제출 기록 동기화용 초경량 API (Node 18+).
 * 실행: node server/submissions-server.mjs
 * 프런트 .env: VITE_SUBMISSIONS_API_URL=http://localhost:8787
 * 권한 분리(권장):
 * - SUBMISSIONS_STUDENT_TOKEN: 학생용(제출 POST만 허용)
 * - SUBMISSIONS_TEACHER_TOKEN: 교사용(GET/PATCH/DELETE/PUT 허용)
 * - (호환) SUBMISSIONS_API_TOKEN: 위 2개가 없을 때 단일 토큰으로 전체 보호
 *
 * 동시성 주의:
 * - 기존: PUT /api/submissions 로 "전체 목록"을 덮어써서 동시 저장 시 유실 가능
 * - 개선: POST/PATCH/DELETE 로 "레코드 단위" 갱신 + 파일 쓰기 락 + (선택) If-Match 버전 충돌 감지
 */
import http from 'http'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import { applySubmissionEnvDefaults, loadEnvForMode } from './load-env.mjs'

loadEnvForMode(process.env.NODE_ENV === 'production' ? 'production' : 'development')
applySubmissionEnvDefaults()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA = path.join(__dirname, 'data', 'submissions.json')
const SESSIONS = path.join(__dirname, 'data', 'teacher-sessions.json')
const PORT = Number(process.env.PORT || 8787)
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

/**
 * 교사 계정(다중) 예시:
 * SUBMISSIONS_TEACHERS_JSON='[
 *   { "id": "t1", "password": "pw1", "depts": ["전기과"] },
 *   { "id": "t2", "password": "pw2", "depts": ["철도전기과","전기과"] },
 *   { "id": "admin", "password": "pw3", "depts": ["*"] }
 * ]'
 */
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
  const out = list
    .map((x) => String(x || '').trim())
    .filter(Boolean)
  // '*' 포함이면 전체 접근
  if (out.includes('*')) return ['*']
  // 중복 제거
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

/** @type {Promise<void>} */
let writeLock = Promise.resolve()

/** @template T @param {() => Promise<T>} fn */
function withWriteLock(fn) {
  const run = async () => fn()
  const next = writeLock.then(run, run)
  writeLock = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

async function readList() {
  try {
    const raw = await fs.readFile(DATA, 'utf8')
    const j = JSON.parse(raw)
    return Array.isArray(j) ? j : []
  } catch {
    return []
  }
}

async function writeList(list) {
  await fs.mkdir(path.dirname(DATA), { recursive: true })
  await fs.writeFile(DATA, JSON.stringify(list, null, 2), 'utf8')
}

async function readSessions() {
  try {
    const raw = await fs.readFile(SESSIONS, 'utf8')
    const j = JSON.parse(raw)
    return j && typeof j === 'object' ? j : {}
  } catch {
    return {}
  }
}

async function writeSessions(obj) {
  await fs.mkdir(path.dirname(SESSIONS), { recursive: true })
  await fs.writeFile(SESSIONS, JSON.stringify(obj, null, 2), 'utf8')
}

async function readJsonBody(req) {
  const chunks = []
  for await (const ch of req) chunks.push(ch)
  const body = Buffer.concat(chunks).toString('utf8').trim()
  if (!body) return null
  return JSON.parse(body)
}

function sendJson(res, status, data, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  })
  res.end(JSON.stringify(data))
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(text)
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, PATCH, DELETE, OPTIONS')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, If-Match',
  )
}

function unauthorized(res) {
  sendText(res, 401, 'Unauthorized')
}

function bearer(req) {
  const h = String(req.headers.authorization || '').trim()
  if (!h.startsWith('Bearer ')) return ''
  return h.slice('Bearer '.length).trim()
}

/**
 * @returns {Promise<{ role: 'none'|'teacher', teacherId?: string, depts?: string[] }>}
 */
async function sessionContext(req) {
  const token = bearer(req)
  if (!token) return { role: 'none' }
  const sessions = await readSessions()
  const raw = sessions?.[token]
  const exp = typeof raw === 'number' ? raw : Number(raw?.exp || 0)
  if (!exp || !Number.isFinite(exp)) return { role: 'none' }
  if (Date.now() > exp) return { role: 'none' }
  const teacherId = raw && typeof raw === 'object' ? String(raw.teacherId || '') : ''
  const depts = raw && typeof raw === 'object' ? normalizeDepts(raw.depts) : []
  return { role: 'teacher', teacherId: teacherId || undefined, depts }
}

/** @returns {'none'|'student'|'teacher'|'all'} */
function authRole(req) {
  const b = bearer(req)
  if (!b) return 'none'
  if (TOKEN_ALL && b === TOKEN_ALL) return 'all'
  if (TOKEN_TEACHER && b === TOKEN_TEACHER) return 'teacher'
  if (TOKEN_STUDENT && b === TOKEN_STUDENT) return 'student'
  return 'none'
}

function requireStudentOrTeacher(req, res) {
  // 토큰 설정이 없으면(개발 편의) 전부 허용
  if (!TOKEN_ALL && !TOKEN_STUDENT && !TOKEN_TEACHER) return true
  const r = authRole(req)
  if (r === 'student' || r === 'teacher' || r === 'all') return true
  unauthorized(res)
  return false
}

/**
 * @returns {Promise<null | { teacherId?: string, depts?: string[] }>}
 */
async function requireTeacher(req, res) {
  if (!TOKEN_ALL && !TOKEN_STUDENT && !TOKEN_TEACHER && !TEACHER_PASSWORD && !TEACHERS_JSON)
    return { depts: ['*'] }
  let r = authRole(req)
  if (r === 'all') return { depts: ['*'] }
  if (r === 'teacher') return { depts: ['*'] }

  // 서버 로그인(세션 토큰)
  const sc = await sessionContext(req)
  if (sc.role === 'teacher') {
    // depts 비어있으면 전체 접근으로 보지 않고 "0개 접근"으로 처리(안전)
    return { teacherId: sc.teacherId, depts: sc.depts || [] }
  }

  unauthorized(res)
  return null
}

function isStudentOnly(req) {
  if (!TOKEN_ALL && !TOKEN_STUDENT && !TOKEN_TEACHER) return false
  return authRole(req) === 'student'
}

function normalizeRecord(incoming, existing = null) {
  const now = Date.now()
  const prev = existing && typeof existing === 'object' ? existing : {}
  const inc = incoming && typeof incoming === 'object' ? incoming : {}

  // 학생이 다시 제출하더라도 교사 피드백이 "없어지지" 않도록 보존
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
  // Expected: W/"<number>"
  if (!s.startsWith('W/"') || !s.endsWith('"')) return null
  const inner = s.slice(3, -1)
  const n = Number(inner)
  return Number.isFinite(n) ? n : null
}

const server = http.createServer(async (req, res) => {
  cors(res)
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  const host = `http://${req.headers.host || 'localhost'}`
  let url
  try {
    url = new URL(req.url || '/', host)
  } catch {
    res.writeHead(400)
    res.end()
    return
  }
  if (!url.pathname.startsWith('/api/')) {
    res.writeHead(404)
    res.end()
    return
  }
  try {
    // POST /api/auth/teacher/login  => {token, expiresAt}
    if (req.method === 'POST' && url.pathname === '/api/auth/teacher/login') {
      const teachers = readTeachersConfig()
      const hasMulti = Array.isArray(teachers) && teachers.length > 0
      if (!TEACHER_PASSWORD && !hasMulti) {
        sendText(res, 400, 'Teacher password is not configured on server')
        return
      }
      const body = await readJsonBody(req)
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

      if (!teacher) {
        sendText(res, 401, 'Unauthorized')
        return
      }
      const token = randomUUID()
      const expiresAt = Date.now() + TEACHER_SESSION_TTL_MS
      await withWriteLock(async () => {
        const sessions = await readSessions()
        // cleanup expired
        const now = Date.now()
        for (const [k, exp] of Object.entries(sessions)) {
          const v = sessions[k]
          const e = typeof v === 'number' ? v : Number(v?.exp || 0)
          if (!e || e < now) delete sessions[k]
        }
        sessions[token] = {
          exp: expiresAt,
          teacherId: teacher.teacherId,
          depts: teacher.depts || [],
        }
        await writeSessions(sessions)
      })
      sendJson(res, 200, {
        token,
        expiresAt,
        teacherId: teacher.teacherId,
        depts: teacher.depts || [],
      })
      return
    }

    // GET /api/submissions
    if (req.method === 'GET' && url.pathname === '/api/submissions') {
      const ctx = await requireTeacher(req, res)
      if (!ctx) return
      const list = await readList()
      sendJson(res, 200, filterByDepts(list, ctx.depts))
      return
    }

    // Legacy: PUT /api/submissions (전체 목록) — 서버에서 merge 처리로 유실 최소화
    if (req.method === 'PUT' && url.pathname === '/api/submissions') {
      if (!(await requireTeacher(req, res))) return
      const body = await readJsonBody(req)
      if (!Array.isArray(body)) {
        sendText(res, 400, 'Body must be an array')
        return
      }
      await withWriteLock(async () => {
        const existing = await readList()
        const byId = new Map()
        for (const r of existing) if (r && r.id) byId.set(String(r.id), r)
        for (const inc of body) {
          if (!inc || !inc.id) continue
          const id = String(inc.id)
          const prev = byId.get(id) || null
          byId.set(id, normalizeRecord(inc, prev))
        }
        const mergedList = Array.from(byId.values()).sort(
          (a, b) => Number(b.submittedAt || 0) - Number(a.submittedAt || 0),
        )
        await writeList(mergedList)
      })
      res.writeHead(204)
      res.end()
      return
    }

    // POST /api/submissions (레코드 업서트)
    if (req.method === 'POST' && url.pathname === '/api/submissions') {
      if (!requireStudentOrTeacher(req, res)) return
      const body = await readJsonBody(req)
      if (!body || typeof body !== 'object') {
        sendText(res, 400, 'Body must be an object')
        return
      }

      // 학생 토큰으로는 "새 제출"만 허용: id는 서버가 발급하고, 교사 필드는 제거합니다.
      const incoming = { ...body }
      if (isStudentOnly(req)) {
        incoming.id = randomUUID()
        delete incoming.teacherFeedback
        delete incoming.feedbackUpdatedAt
        delete incoming.version
        delete incoming.updatedAt
        delete incoming.createdAt
      } else {
        if (!incoming.id) {
          sendText(res, 400, 'Missing id')
          return
        }
      }

      const id = String(incoming.id)
      const updated = await withWriteLock(async () => {
        const list = await readList()
        const idx = list.findIndex((x) => x && String(x.id) === id)
        const prev = idx >= 0 ? list[idx] : null
        const next = normalizeRecord(incoming, prev)
        if (idx >= 0) list[idx] = next
        else list.push(next)
        list.sort((a, b) => Number(b.submittedAt || 0) - Number(a.submittedAt || 0))
        await writeList(list)
        return next
      })
      sendJson(res, 200, updated, { ETag: `W/"${updated.version}"` })
      return
    }

    // PATCH/DELETE /api/submissions/:id
    const m = url.pathname.match(/^\/api\/submissions\/([^/]+)$/)
    if (m) {
      const id = decodeURIComponent(m[1])

      if (req.method === 'DELETE') {
        const ctx = await requireTeacher(req, res)
        if (!ctx) return
        await withWriteLock(async () => {
          const list = await readList()
          const hit = list.find((x) => x && String(x.id) === String(id))
          if (hit && !deptAllowed(ctx.depts, hit?.student?.dept)) return
          const next = list.filter((x) => !(x && String(x.id) === String(id)))
          await writeList(next)
        })
        res.writeHead(204)
        res.end()
        return
      }

      if (req.method === 'PATCH') {
        const ctx = await requireTeacher(req, res)
        if (!ctx) return
        const patch = await readJsonBody(req)
        if (!patch || typeof patch !== 'object') {
          sendText(res, 400, 'Body must be an object')
          return
        }

        const ifMatch = parseWeakEtag(req.headers['if-match'])
        const updated = await withWriteLock(async () => {
          const list = await readList()
          const idx = list.findIndex((x) => x && String(x.id) === String(id))
          if (idx < 0) return null
          const prev = list[idx]
          if (!deptAllowed(ctx.depts, prev?.student?.dept)) return null
          const prevVer = Number(prev?.version || 0)
          if (ifMatch !== null && prevVer !== ifMatch) {
            return { conflict: true, current: prev }
          }
          const next = normalizeRecord(patch, prev)
          list[idx] = next
          await writeList(list)
          return next
        })

        if (!updated) {
          sendText(res, 404, 'Not found')
          return
        }
        if (updated && updated.conflict) {
          sendJson(res, 409, { message: 'Version conflict', current: updated.current })
          return
        }
        sendJson(res, 200, updated, { ETag: `W/"${updated.version}"` })
        return
      }
    }

    // GET /api/submissions/:id/status  => { id, feedbackReady, feedbackUpdatedAt }
    {
      const ms = url.pathname.match(/^\/api\/submissions\/([^/]+)\/status$/)
      if (ms && req.method === 'GET') {
        // 학생/교사 모두 허용(토큰 없으면 개발 편의로 허용)
        if (!requireStudentOrTeacher(req, res)) return
        const id = decodeURIComponent(ms[1])
        const list = await readList()
        const hit = list.find((x) => x && String(x.id) === String(id)) || null
        if (!hit) {
          sendText(res, 404, 'Not found')
          return
        }

        // 교사(토큰/세션)라면 학과 필터를 적용
        // 학생은 본인 id(UUID)를 알고 있다는 전제로, 작성 여부만 조회 가능
        const r = authRole(req)
        if (r === 'teacher' || r === 'all') {
          // teacher/all 토큰은 전체 접근
        } else {
          const sc = await sessionContext(req).catch(() => ({ role: 'none' }))
          if (sc?.role === 'teacher') {
            const depts = Array.isArray(sc.depts) ? sc.depts : []
            if (!deptAllowed(depts, hit?.student?.dept)) {
              sendText(res, 404, 'Not found')
              return
            }
          }
        }

        const teacherFeedback = String(hit?.teacherFeedback || '').trim()
        const feedbackUpdatedAt = Number(hit?.feedbackUpdatedAt || 0)
        sendJson(res, 200, {
          id: String(hit.id),
          feedbackReady: Boolean(teacherFeedback),
          feedbackUpdatedAt:
            Number.isFinite(feedbackUpdatedAt) && feedbackUpdatedAt > 0
              ? feedbackUpdatedAt
              : null,
        })
        return
      }
    }
  } catch (e) {
    sendText(res, 500, e instanceof Error ? e.message : 'error')
    return
  }
  res.writeHead(405)
  res.end()
})

const HOST = (process.env.SUBMISSIONS_BIND_HOST || '0.0.0.0').trim()
server.listen(PORT, HOST, () => {
  console.log(
    `[submissions API] http://127.0.0.1:${PORT}/api/submissions (LAN: 포트 ${PORT})` +
      (TOKEN_ALL || TOKEN_STUDENT || TOKEN_TEACHER ? ' (Bearer 토큰 필요)' : ''),
  )
})
