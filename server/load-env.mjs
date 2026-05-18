/**
 * Node 스크립트용 .env 로더 (Vite와 동일 루트).
 * 이미 process.env에 있는 값은 덮어쓰지 않습니다.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/** @param {string} filename */
export function loadEnvFile(filename = '.env') {
  const p = path.join(ROOT, filename)
  if (!fs.existsSync(p)) return
  applyEnvText(fs.readFileSync(p, 'utf8'))
}

/** @param {string} text */
function applyEnvText(text) {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    const key = t.slice(0, eq).trim()
    if (!key) continue
    let val = t.slice(eq + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = val
    }
  }
}

/** Vite dev와 동일: .env → .env.local → .env.[mode] → .env.[mode].local */
export function loadEnvForMode(mode = 'development') {
  loadEnvFile('.env')
  loadEnvFile('.env.local')
  if (mode) {
    loadEnvFile(`.env.${mode}`)
    loadEnvFile(`.env.${mode}.local`)
  }
}

/** 제출 API 서버가 쓸 토큰·교사 비밀번호 기본값 정리 */
export function applySubmissionEnvDefaults() {
  const student =
    (process.env.SUBMISSIONS_STUDENT_TOKEN || '').trim() ||
    (process.env.VITE_SUBMISSIONS_STUDENT_TOKEN || '').trim()
  if (student) {
    if (!(process.env.SUBMISSIONS_STUDENT_TOKEN || '').trim()) {
      process.env.SUBMISSIONS_STUDENT_TOKEN = student
    }
    if (!(process.env.VITE_SUBMISSIONS_STUDENT_TOKEN || '').trim()) {
      process.env.VITE_SUBMISSIONS_STUDENT_TOKEN = student
    }
  }
  const teacherPw =
    (process.env.SUBMISSIONS_TEACHER_PASSWORD || '').trim() ||
    (process.env.VITE_TEACHER_PASSWORD || '').trim()
  if (teacherPw && !(process.env.SUBMISSIONS_TEACHER_PASSWORD || '').trim()) {
    process.env.SUBMISSIONS_TEACHER_PASSWORD = teacherPw
  }
}
