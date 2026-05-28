/** @typedef {{ s: string, w: string, o: string, t: string }} Swot */

export const SUBMISSIONS_KEY = 'circuit_journal_submissions_v1'
export const TEACHER_AUTH_KEY = 'circuit_teacher_auth'
export const TEACHER_LAST_SEEN_KEY = 'circuit_teacher_last_seen_count'
export const TEACHER_API_SESSION_KEY = 'circuit_teacher_api_session_token'
const FEEDBACK_DONE_KEY_PREFIX = 'circuit_submission_feedback_done_v1:'

function getTeacherAuthLocal() {
  return sessionStorage.getItem(TEACHER_AUTH_KEY) === '1'
}

export function setTeacherApiSessionToken(token) {
  if (token) sessionStorage.setItem(TEACHER_API_SESSION_KEY, String(token))
  else sessionStorage.removeItem(TEACHER_API_SESSION_KEY)
}

function getTeacherApiSessionToken() {
  return sessionStorage.getItem(TEACHER_API_SESSION_KEY) || ''
}

/**
 * @typedef {{
 *   id: string
 *   submittedAt: number
 *   student: { subject: string, date: string, dept: string, info: string }
 *   currentPage: number
 *   progressLabel: string
 *   hasCircuit: boolean
 *   hasProcess: boolean
 *   hasFinal: boolean
 *   selfEval: string
 *   swot: Swot
 *   aiSummary?: string
 *   chatTranscript?: string
 *   learningMinutes: number | null
 *   images: { circuit?: string, final?: string[], process?: string[] }
 *   teacherFeedback?: string
 *   feedbackUpdatedAt?: number
 *   version?: number
 *   updatedAt?: number
 *   createdAt?: number
 * }} SubmissionRecord
 */

function getApiBase() {
  const u = import.meta.env.VITE_SUBMISSIONS_API_URL
  if (typeof u === 'string' && u.trim()) return u.replace(/\/$/, '')
  // Vercel 등: 별도 URL 없이 같은 출처 /api/* 로 동기화
  if (import.meta.env.VITE_SUBMISSIONS_SAME_ORIGIN === 'true') {
    if (typeof window !== 'undefined' && window.location?.origin) {
      return window.location.origin.replace(/\/$/, '')
    }
  }
  return ''
}

/** 교사 로그인·제출 API 베이스 (main.js 등에서 사용) */
export function getSubmissionsApiBase() {
  return getApiBase()
}

function getApiToken() {
  // 배포 시 학생/교사 권한 분리를 위해 토큰을 분리합니다.
  // - 학생: VITE_SUBMISSIONS_STUDENT_TOKEN
  // - 교사: VITE_SUBMISSIONS_TEACHER_TOKEN (교사 모드 로그인 후)
  // - (호환) VITE_SUBMISSIONS_API_TOKEN: 단일 토큰
  const isTeacher = getTeacherAuthLocal()
  const sessionToken = isTeacher ? getTeacherApiSessionToken().trim() : ''
  const t =
    sessionToken ||
    (isTeacher ? import.meta.env.VITE_SUBMISSIONS_TEACHER_TOKEN : '') ||
    (!isTeacher ? import.meta.env.VITE_SUBMISSIONS_STUDENT_TOKEN : '') ||
    import.meta.env.VITE_SUBMISSIONS_API_TOKEN
  return typeof t === 'string' ? t.trim() : ''
}

function authHeaders() {
  const token = getApiToken()
  const h = { 'Content-Type': 'application/json; charset=utf-8' }
  if (token) h.Authorization = `Bearer ${token}`
  return h
}

/** @param {number | undefined} v */
function ifMatchHeader(v) {
  return typeof v === 'number' && Number.isFinite(v) ? { 'If-Match': `W/"${v}"` } : {}
}

function authHeadersGet() {
  const token = getApiToken()
  /** @type {Record<string, string>} */
  const h = {}
  if (token) h.Authorization = `Bearer ${token}`
  return h
}

/** 원격 제출 동기화 사용 여부(안내 문구 등) */
export function isRemoteSubmissionsEnabled() {
  return Boolean(getApiBase())
}

/** 레거시 ?mode= 쿼리 (기본: REST 경로만 사용) */
function useLegacySubmissionRouteHints() {
  return import.meta.env.VITE_SUBMISSIONS_LEGACY_QUERY === 'true'
}

/** @param {string} base */
function apiListSubmissionsUrl(base) {
  const b = String(base || '').replace(/\/$/, '')
  return useLegacySubmissionRouteHints() ? `${b}/api/submissions?mode=list` : `${b}/api/submissions`
}

/** @param {string} base @param {string} id */
function apiSubmissionStatusUrl(base, id) {
  const b = String(base || '').replace(/\/$/, '')
  const p = `${b}/api/submissions/${encodeURIComponent(id)}/status`
  return useLegacySubmissionRouteHints()
    ? `${p}?mode=status&rid=${encodeURIComponent(id)}`
    : p
}

/** @param {string} base @param {string} id */
function apiSubmissionRecordUrl(base, id) {
  const b = String(base || '').replace(/\/$/, '')
  const p = `${b}/api/submissions/${encodeURIComponent(id)}`
  return useLegacySubmissionRouteHints()
    ? `${p}?mode=record&rid=${encodeURIComponent(id)}`
    : p
}

/** @returns {Promise<SubmissionRecord[]>} */
async function fetchRemoteList() {
  const base = getApiBase()
  if (!base) throw new Error('no API')
  const r = await fetch(apiListSubmissionsUrl(base), { headers: authHeadersGet() })
  if (!r.ok) throw new Error(`GET ${r.status}`)
  const data = await r.json()
  return Array.isArray(data) ? data : []
}

/** @param {string} id @returns {Promise<{ feedbackReady: boolean, feedbackUpdatedAt: number | null } | null>} */
export async function fetchRemoteFeedbackStatus(id) {
  const base = getApiBase()
  if (!base) return null
  const sid = String(id || '').trim()
  if (!sid) return null
  const r = await fetch(apiSubmissionStatusUrl(base, sid), {
    headers: authHeadersGet(),
  })
  if (!r.ok) return null
  const j = await r.json().catch(() => null)
  if (!j || typeof j !== 'object') return null
  return {
    feedbackReady: Boolean(j.feedbackReady),
    feedbackUpdatedAt:
      typeof j.feedbackUpdatedAt === 'number' && Number.isFinite(j.feedbackUpdatedAt)
        ? j.feedbackUpdatedAt
        : null,
  }
}

/** @param {SubmissionRecord} record @returns {Promise<SubmissionRecord>} */
async function postRemoteUpsert(record) {
  const base = getApiBase()
  if (!base) throw new Error('no API')
  const r = await fetch(apiListSubmissionsUrl(base), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(record),
  })
  if (!r.ok) {
    const detail = await r.text().catch(() => '')
    if (r.status === 401) {
      throw new Error(
        '제출 인증에 실패했습니다. 배포 사이트라면 환경 변수(VITE_SUBMISSIONS_STUDENT_TOKEN)를 확인하세요.',
      )
    }
    throw new Error(
      (() => {
        const d = String(detail || '')
        if (/FUNCTION_INVOCATION_FAILED|Cannot find module/i.test(d)) {
          return '제출 서버 설정 오류입니다. Vercel Functions 로그를 확인하거나 잠시 후 다시 시도해 주세요.'
        }
        if (/KV is not configured|제출 저장소/i.test(d)) {
          return d.slice(0, 200)
        }
        return `제출 서버 오류 (${r.status})${d ? `: ${d.slice(0, 120)}` : ''}`
      })(),
    )
  }
  const out = await r.json()
  return out && typeof out === 'object' ? out : record
}

/**
 * @param {string} id
 * @param {Partial<SubmissionRecord>} patch
 * @param {number | undefined} version
 * @returns {Promise<SubmissionRecord | null>}
 */
async function patchRemoteRecord(id, patch, version) {
  const base = getApiBase()
  if (!base) throw new Error('no API')
  const r = await fetch(apiSubmissionRecordUrl(base, id), {
    method: 'PATCH',
    headers: { ...authHeaders(), ...ifMatchHeader(version) },
    body: JSON.stringify(patch),
  })
  if (r.status === 404) return null
  if (r.status === 409) {
    // 서버 버전이 더 최신이면 서버 값을 채택(로컬 유실 방지)
    const j = await r.json().catch(() => null)
    if (j && j.current) return j.current
  }
  if (!r.ok) throw new Error(`PATCH ${r.status}`)
  const out = await r.json()
  return out && typeof out === 'object' ? out : null
}

/** @param {string} id */
async function deleteRemoteRecord(id) {
  const base = getApiBase()
  if (!base) return
  const r = await fetch(apiSubmissionRecordUrl(base, id), {
    method: 'DELETE',
    headers: authHeadersGet(),
  })
  if (!r.ok && r.status !== 404) throw new Error(`DELETE ${r.status}`)
}

/**
 * 앱 시작 시 1회: 원격 URL이 있으면 서버 목록을 받아 로컬에 반영합니다.
 */
export async function initTeacherStorage() {
  if (!getApiBase()) return
  try {
    const remote = await fetchRemoteList()
    saveSubmissionsLocal(remote)
  } catch (e) {
    console.warn('[submissions] 원격 불러오기 실패, 로컬 데이터 사용:', e)
  }
}

function loadSubmissionsLocal() {
  try {
    const raw = localStorage.getItem(SUBMISSIONS_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? /** @type {SubmissionRecord[]} */ (arr) : []
  } catch {
    return []
  }
}

/** @param {SubmissionRecord[]} list */
function saveSubmissionsLocal(list) {
  try {
    localStorage.setItem(SUBMISSIONS_KEY, JSON.stringify(list))
  } catch (e) {
    console.error(e)
    throw new Error(
      '저장 공간이 부족합니다. 브라우저 저장소 한도를 줄이려면 이미지를 줄이거나 이전 제출을 삭제하세요.',
    )
  }
}

/** @param {SubmissionRecord[]} list */
function persistListLocalOnly(list) {
  saveSubmissionsLocal(list)
}

export function loadSubmissions() {
  return loadSubmissionsLocal()
}

/** @param {SubmissionRecord} record */
export async function upsertSubmission(record) {
  const list = loadSubmissionsLocal()
  const idx = list.findIndex((r) => r.id === record.id)
  if (idx >= 0) list[idx] = record
  else list.push(record)
  list.sort((a, b) => b.submittedAt - a.submittedAt)
  persistListLocalOnly(list)

  if (getApiBase()) {
    const remote = await postRemoteUpsert(record)
    // 원격에서 version/updatedAt 등이 붙었으면 로컬에도 반영
    const list2 = loadSubmissionsLocal()
    // 서버가 학생 제출 id를 새로 발급하는 경우, 기존 로컬 레코드는 제거합니다.
    const nextList = list2.filter((r) => r.id !== record.id || record.id === remote.id)
    const idx2 = nextList.findIndex((r) => r.id === remote.id)
    if (idx2 >= 0) nextList[idx2] = remote
    else nextList.push(remote)
    // 정렬 유지
    nextList.sort((a, b) => b.submittedAt - a.submittedAt)
    persistListLocalOnly(nextList)
    return remote
  }
  return record
}

/** @param {string} id @param {string} teacherFeedback */
export async function updateSubmissionFeedback(id, teacherFeedback) {
  const list = loadSubmissionsLocal()
  const r = list.find((x) => x.id === id)
  if (!r) return false
  r.teacherFeedback = teacherFeedback
  r.feedbackUpdatedAt = Date.now()
  persistListLocalOnly(list)

  // 학생 화면(보고서)에서 피드백 작성 여부를 쉽게 인지할 수 있도록 표시 플래그를 남깁니다.
  // - 같은 브라우저/기기에서 학생이 PDF 내보내기 전에 확인 가능
  // - 서버 권한(학생은 제출만 허용) 환경에서도 동작
  try {
    const k = `${FEEDBACK_DONE_KEY_PREFIX}${String(id)}`
    const v = teacherFeedback && String(teacherFeedback).trim() ? String(r.feedbackUpdatedAt) : ''
    if (v) localStorage.setItem(k, v)
    else localStorage.removeItem(k)
  } catch {
    // ignore
  }

  if (getApiBase()) {
    const patch = { teacherFeedback, feedbackUpdatedAt: r.feedbackUpdatedAt }
    const tryOnce = async () => patchRemoteRecord(id, patch, r.version)
    let remote
    try {
      remote = await tryOnce()
    } catch {
      // 첫 요청 실패(서버 cold start/일시 오류) 시 1회 재시도
      await new Promise((resolve) => setTimeout(resolve, 250))
      remote = await tryOnce()
    }
    if (remote) {
      const list2 = loadSubmissionsLocal()
      const idx2 = list2.findIndex((x) => x.id === id)
      if (idx2 >= 0) list2[idx2] = remote
      persistListLocalOnly(list2)
    }
  }
  return true
}

/** @param {string} id @returns {number | null} */
export function getLocalFeedbackDoneTimestamp(id) {
  try {
    const k = `${FEEDBACK_DONE_KEY_PREFIX}${String(id)}`
    const raw = localStorage.getItem(k) || ''
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/** @param {string} id */
export async function removeSubmission(id) {
  const list = loadSubmissionsLocal().filter((r) => r.id !== id)
  persistListLocalOnly(list)
  if (getApiBase()) {
    await deleteRemoteRecord(id)
  }
}

export function getTeacherAuth() {
  return getTeacherAuthLocal()
}

/** @param {boolean} v */
export function setTeacherAuth(v) {
  if (v) sessionStorage.setItem(TEACHER_AUTH_KEY, '1')
  else sessionStorage.removeItem(TEACHER_AUTH_KEY)
}

export function getLastSeenCount() {
  const n = Number(localStorage.getItem(TEACHER_LAST_SEEN_KEY) || '0')
  return Number.isFinite(n) ? n : 0
}

/** @param {number} n */
export function setLastSeenCount(n) {
  localStorage.setItem(TEACHER_LAST_SEEN_KEY, String(n))
}

/**
 * @param {File} file
 * @param {number} [maxW]
 * @param {number} [quality]
 * @returns {Promise<string>}
 */
/**
 * @param {string} dataUrl
 * @param {number} [maxW]
 * @param {number} [quality]
 */
export function compressDataUrlJpeg(dataUrl, maxW = 960, quality = 0.72) {
  const src = String(dataUrl || '').trim()
  if (!src || !/^data:image\//i.test(src)) {
    return Promise.resolve('')
  }
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      let w = img.naturalWidth || img.width
      let h = img.naturalHeight || img.height
      if (w > maxW) {
        h = (h * maxW) / w
        w = maxW
      }
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(w))
      canvas.height = Math.max(1, Math.round(h))
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('canvas를 사용할 수 없습니다.'))
        return
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      const q =
        typeof quality === 'number' && Number.isFinite(quality)
          ? Math.max(0.5, Math.min(0.92, quality))
          : 0.72
      resolve(canvas.toDataURL('image/jpeg', q))
    }
    img.onerror = () => reject(new Error('이미지를 읽지 못했습니다.'))
    img.src = src
  })
}

export function fileToCompressedJpegDataUrl(file, maxW = 1200, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      let w = img.naturalWidth || img.width
      let h = img.naturalHeight || img.height
      if (w > maxW) {
        h = (h * maxW) / w
        w = maxW
      }
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(w))
      canvas.height = Math.max(1, Math.round(h))
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('canvas를 사용할 수 없습니다.'))
        return
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      const q =
        typeof quality === 'number' && Number.isFinite(quality)
          ? Math.max(0.5, Math.min(0.92, quality))
          : 0.72
      resolve(canvas.toDataURL('image/jpeg', q))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('이미지를 읽지 못했습니다.'))
    }
    img.src = url
  })
}
