import './style.css'
import { isOpenAiProxyAvailable, sendOpenAiChat } from './openai.js'
import {
  formatPracticeDateKorean,
} from './journal-hwpx.js'
import { buildJournalPdfElement, saveElementAsPdf } from './journal-pdf.js'
import {
  fileToCompressedJpegDataUrl,
  fetchRemoteFeedbackStatus,
  getLastSeenCount,
  getLocalFeedbackDoneTimestamp,
  getTeacherAuth,
  initTeacherStorage,
  getSubmissionsApiBase,
  isRemoteSubmissionsEnabled,
  loadSubmissions,
  removeSubmission,
  setLastSeenCount,
  setTeacherAuth,
  setTeacherApiSessionToken,
  updateSubmissionFeedback,
  upsertSubmission,
} from './teacher-storage.js'

const MATERIAL_ITEMS = [
  '4핀 단자대',
  '10핀 단자대',
  '1구 컨트롤 박스',
  '2구 컨트롤 박스',
  '3구 컨트롤 박스',
  '8핀 베이스',
  '8핀 베이스(철도전기용)',
  '12핀 베이스',
  '14핀 베이스',
  'MCCB',
  '퓨즈홀더',
  '팔각박스',
]

const LAST_SUBMISSION_ID_KEY = 'circuit_last_submission_id_v1'
const LAST_SUBMISSION_ID_KEY_V2_PREFIX = 'circuit_last_submission_id_v2:'

function stableStudentIdentity() {
  // 같은 PC/브라우저에서 여러 학생이 사용하므로, "마지막 제출"을 학생별로 분리합니다.
  // 식별 정보가 비어 있으면(아직 입력 전) 이전 사용자의 상태를 절대 노출하지 않습니다.
  const subject = String(state?.data?.subject || '').trim()
  const date = String(state?.data?.date || '').trim()
  const dept = String(state?.data?.dept || '').trim()
  const info = String(state?.data?.info || '').trim()
  if (!subject || !dept || !info) return null
  return { subject, date, dept, info }
}

function hashDjb2(str) {
  let h = 5381
  for (let i = 0; i < str.length; i++) h = (h * 33) ^ str.charCodeAt(i)
  // unsigned 32-bit hex
  return (h >>> 0).toString(16).padStart(8, '0')
}

function lastSubmissionKeyForCurrentStudent() {
  const ident = stableStudentIdentity()
  if (!ident) return null
  return `${LAST_SUBMISSION_ID_KEY_V2_PREFIX}${hashDjb2(JSON.stringify(ident))}`
}

function getLastSubmissionIdForCurrentStudent() {
  // 핵심: 이번 사용(세션)에서 제출 버튼을 누른 적이 없으면,
  // 과거 로컬 저장값으로 "피드백 완료"가 노출되면 안 됩니다.
  return String(state?.session?.teacherSubmittedId || '').trim()
}

function setLastSubmissionIdForCurrentStudent(id) {
  const sid = String(id || '').trim()
  if (!sid) return
  const v2 = lastSubmissionKeyForCurrentStudent()
  try {
    if (v2) localStorage.setItem(v2, sid)
  } catch {
    // ignore
  }
  // v1은 남겨두되, 학생별 키가 우선 사용되므로 노출 문제는 방지됩니다.
  try {
    localStorage.setItem(LAST_SUBMISSION_ID_KEY, sid)
  } catch {
    // ignore
  }
}

const formatKoreanTime = (ts) => {
  if (!ts || !Number.isFinite(ts)) return ''
  try {
    const d = new Date(ts)
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    const hh = String(d.getHours()).padStart(2, '0')
    const mi = String(d.getMinutes()).padStart(2, '0')
    return `${mm}/${dd} ${hh}:${mi}`
  } catch {
    return ''
  }
}

function defaultMaterialCounts() {
  return Object.fromEntries(MATERIAL_ITEMS.map((k) => [k, 0]))
}

/** 학습자 / 관리자 화면. 관리자는 비밀번호 확인 후 대시보드(상단 학습자 모드 버튼 없음, 로그인 창에서만 복귀). */
const state = {
  teacherView: false,
  /** @type {string | null} */
  teacherSelectedId: null,
  /** @type {Set<string>} */
  teacherCheckedIds: new Set(),
  teacherFilterDept: '',
  teacherFilterSubject: '',
  // 교사 대시보드는 검색 중 전체 리렌더를 하지 않으므로 IME/포커스 플래그 불필요
  page: 1,
  session: {
    /** 첫 페이지에서 다음 페이지를 누른 시각 (ms) */
    startedAt: null,
    /** 최종 결과물(4페이지) 사진 업로드가 마지막으로 발생한 시각 (ms) */
    finalUploadedAt: null,
    /** 이번 사용(세션)에서 실제로 '교사 Dashboard에 제출'을 눌러 생성된 제출 id */
    teacherSubmittedId: null,
  },
  data: {
    subject: '',
    date: new Date().toISOString().slice(0, 10),
    dept: '',
    info: '',
    materialCounts: defaultMaterialCounts(),
    circuitImg: null,
    circuitPreviewUrl: null,
    processImgs: [],
    processPreviewUrls: [],
    finalImgs: [],
    finalPreviewUrls: [],
    selfEval: '',
  },
  /** @type {{ swot: { s: string, w: string, o: string, t: string }, selfEval: string } | null} */
  journalSnapshot: null,
  messages: [],
}

function escapeHtml(s) {
  const div = document.createElement('div')
  div.textContent = s
  return div.innerHTML
}

function formatInlineMarkdownLite(escaped) {
  // escaped: 이미 HTML escape 처리된 문자열
  let out = String(escaped ?? '')
  // inline code: `like this`
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>')
  // bold: **text**
  out = out.replace(/\*\*([^*][\s\S]*?)\*\*/g, '<strong>$1</strong>')
  return out
}

function renderMarkdownLiteToHtml(raw) {
  const lines = String(raw ?? '').replace(/\r\n/g, '\n').split('\n')
  /** @type {string[]} */
  const out = []
  /** @type {'ul' | 'ol' | null} */
  let listType = null
  /** @type {string[]} */
  let para = []
  let inCode = false
  /** @type {string[]} */
  let codeLines = []

  const closeList = () => {
    if (!listType) return
    out.push(listType === 'ul' ? '</ul>' : '</ol>')
    listType = null
  }
  const flushCode = () => {
    if (!codeLines.length) {
      out.push('<pre class="md-pre"><code></code></pre>')
      codeLines = []
      return
    }
    const code = escapeHtml(codeLines.join('\n'))
    out.push(`<pre class="md-pre"><code>${code}</code></pre>`)
    codeLines = []
  }
  const flushPara = () => {
    if (!para.length) return
    const escapedLines = para.map((l) => formatInlineMarkdownLite(escapeHtml(l)))
    out.push(`<p>${escapedLines.join('<br />')}</p>`)
    para = []
  }

  for (const line0 of lines) {
    const line = String(line0 ?? '')
    const trimmed = line.trim()

    // fenced code blocks: ``` ... ```
    if (/^```/.test(trimmed)) {
      closeList()
      flushPara()
      if (inCode) {
        flushCode()
        inCode = false
      } else {
        inCode = true
        codeLines = []
      }
      continue
    }
    if (inCode) {
      codeLines.push(line)
      continue
    }

    if (!trimmed) {
      closeList()
      flushPara()
      continue
    }

    const h3 = /^###\s+(.+)$/.exec(line)
    if (h3) {
      closeList()
      flushPara()
      out.push(`<h3>${formatInlineMarkdownLite(escapeHtml(h3[1]))}</h3>`)
      continue
    }
    const h2 = /^##\s+(.+)$/.exec(line)
    if (h2) {
      closeList()
      flushPara()
      out.push(`<h2>${formatInlineMarkdownLite(escapeHtml(h2[1]))}</h2>`)
      continue
    }

    const ul = /^[-*]\s+(.+)$/.exec(line)
    if (ul) {
      flushPara()
      if (listType !== 'ul') {
        closeList()
        out.push('<ul>')
        listType = 'ul'
      }
      out.push(`<li>${formatInlineMarkdownLite(escapeHtml(ul[1]))}</li>`)
      continue
    }

    const ol = /^(\d+)\.\s+(.+)$/.exec(line)
    if (ol) {
      flushPara()
      if (listType !== 'ol') {
        closeList()
        out.push('<ol>')
        listType = 'ol'
      }
      out.push(`<li>${formatInlineMarkdownLite(escapeHtml(ol[2]))}</li>`)
      continue
    }

    // 일반 문단
    closeList()
    para.push(line)
  }

  if (inCode) {
    // 닫히지 않은 ``` 이 있더라도 안전하게 마무리
    flushCode()
    inCode = false
  }
  closeList()
  flushPara()
  return out.join('\n')
}

function readSwotFromReport(root) {
  const lis = root.querySelectorAll('.swot-list li')
  const keys = ['s', 'w', 'o', 't']
  const out = { s: '', w: '', o: '', t: '' }
  lis.forEach((li, i) => {
    const span = li.querySelector('span:last-of-type')
    const k = keys[i]
    if (k) out[k] = span?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  })
  return out
}

function buildChatTranscriptForReport() {
  const msgs = Array.isArray(state.messages) ? state.messages : []
  const tail = msgs.slice(-14)
  const lines = tail.map((m) => {
    const who = m.role === 'user' ? 'USER' : 'Circuit AI'
    const content = String(m.content ?? '').trim()
    return `${who}: ${content}`
  })
  const joined = lines.join('\n\n').trim()
  // 과도한 프롬프트/요청 본문 크기를 방지 (대략 6k chars)
  return joined.length > 6000 ? joined.slice(joined.length - 6000) : joined
}

function tryParseJsonLoose(s) {
  const raw = String(s || '').trim()
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    // ```json ... ``` 형태를 최대한 복구
    const m = /```json\s*([\s\S]*?)```/i.exec(raw)
    if (m?.[1]) {
      try {
        return JSON.parse(m[1])
      } catch {
        return null
      }
    }
    return null
  }
}

async function generateAiReportInsights(opts = {}) {
  if (!isOpenAiProxyAvailable()) return null

  /** @type {{ dataUrl: string, label?: string }[]} */
  const images = []
  if (state.data.circuitImg) {
    images.push({
      label: '회로도',
      dataUrl: await fileToCompressedJpegDataUrl(state.data.circuitImg),
    })
  }
  if (state.data.finalImgs?.length) {
    const f = state.data.finalImgs[state.data.finalImgs.length - 1]
    if (f) {
      images.push({
        label: '최종 결과 사진(최근)',
        dataUrl: await fileToCompressedJpegDataUrl(f),
      })
    }
  } else if (state.data.processImgs?.length) {
    const f = state.data.processImgs[state.data.processImgs.length - 1]
    if (f) {
      images.push({
        label: '실습 진행 사진(최근)',
        dataUrl: await fileToCompressedJpegDataUrl(f),
      })
    }
  }

  const transcript = buildChatTranscriptForReport()
  const practiceBlock = buildPracticeContextForAi()
  const sw = opts.swot
  const swotLine = (v) => {
    const s = String(v ?? '').replace(/\s+/g, ' ').trim()
    return !s || s === '—' ? '(없음)' : s
  }
  const swotCtx =
    sw &&
    [sw.s, sw.w, sw.o, sw.t].some((x) => {
      const t = String(x ?? '').replace(/\s+/g, ' ').trim()
      return t && t !== '—'
    })
      ? `학습자가 화면에 적어 둔 SWOT(확인된 내용만 반영, 빈 칸은 없음):
- S: ${swotLine(sw.s)}
- W: ${swotLine(sw.w)}
- O: ${swotLine(sw.o)}
- T: ${swotLine(sw.t)}`
      : ''

  const prompt = `너는 전기 실습을 돕는 조교야. 아래 대화, 이미지(있으면), 자기평가·SWOT 요약을 바탕으로 보고서용 결과를 생성해줘.

요구사항:
- 반드시 JSON만 출력
- 키는 summary, swot 를 포함
- summary: 한국어 1~3문장. 확인된 근거가 있을 때만 실습 피드백을 쓰고, 근거가 부족하면 "제공된 자료만으로는 구체 평가가 어렵습니다."로 시작하는 짧은 안내만.
- swot: { "s": "...", "w": "...", "o": "...", "t": "..." } 각각 한국어 1줄(짧게). 근거가 없으면 각 값을 "추가 자료 필요"로만 채워라. SWOT 항목을 추측으로 채우지 마라.
- 대화·이미지·자기평가·SWOT 어디에도 없는 단자번호·배선·측정값·고장 단정을 만들지 마라.

엄격 규칙:
- 자료가 빈약하면(대화가 거의 없고 이미지도 없거나 판독 불가에 자기평가·SWOT도 비어 있음) summary는 한두 문장, swot 네 칸 모두 "추가 자료 필요"로 통일해도 된다.

대화:
${transcript || '(대화 없음)'}

${practiceBlock}
${swotCtx ? `\n${swotCtx}\n` : ''}`

  const text = await sendOpenAiChat(
    [{ role: 'user', content: prompt }],
    '최종 보고서(SWOT/종합 피드백) 생성',
    images,
  )

  const parsed = tryParseJsonLoose(text)
  if (!parsed) return null
  const swot = parsed.swot || {}
  return {
    summary: String(parsed.summary || '').trim(),
    swot: {
      s: String(swot.s || '').trim(),
      w: String(swot.w || '').trim(),
      o: String(swot.o || '').trim(),
      t: String(swot.t || '').trim(),
    },
  }
}

function ensureJournalPdfMount() {
  let m = document.getElementById('journal-pdf-mount')
  if (!m) {
    m = document.createElement('div')
    m.id = 'journal-pdf-mount'
    m.className = 'journal-pdf-mount'
    document.body.appendChild(m)
  }
  return m
}

function revokeIfUrl(url) {
  if (url && url.startsWith('blob:')) URL.revokeObjectURL(url)
}

function getTeacherFeedbackStatusForLastSubmission() {
  const id = getLastSubmissionIdForCurrentStudent()
  if (!id) return { kind: 'none', text: '아직 교사의 피드백이 입력되지 않았습니다.' }

  const rec = loadSubmissions().find((r) => r.id === id) || null
  const doneTs = getLocalFeedbackDoneTimestamp(id)
  const hasFeedback = Boolean(rec?.teacherFeedback && String(rec.teacherFeedback).trim())
  const ts = rec?.feedbackUpdatedAt || doneTs || null
  if (hasFeedback || doneTs) {
    const when = ts ? ` (${formatKoreanTime(Number(ts))})` : ''
    return { kind: 'done', text: `교사 피드백 작성이 완료되었습니다.${when}` }
  }
  return { kind: 'pending', text: '교사 피드백을 기다리는 중입니다. (작성 완료 후 PDF 내보내기를 진행하세요.)' }
}

function renderTeacherFeedbackStatus(root) {
  const el = root?.querySelector?.('.teacher-feedback-status')
  if (!el) return
  const s = getTeacherFeedbackStatusForLastSubmission()
  el.hidden = false
  el.textContent = s.text
  el.className =
    s.kind === 'done'
      ? 'success-msg teacher-feedback-status'
      : s.kind === 'pending'
        ? 'info-banner teacher-feedback-status'
        : 'info-banner info-banner--soft teacher-feedback-status'
}

async function refreshTeacherFeedbackStatusFromServer(root) {
  if (!isRemoteSubmissionsEnabled()) return
  const id = getLastSubmissionIdForCurrentStudent()
  if (!id) return

  const remote = await fetchRemoteFeedbackStatus(id)
  if (!remote) return

  // 원격에서 피드백 완료로 확인되면, 로컬 표시도 즉시 반영되도록 submissions 로컬에도 동기화
  if (remote.feedbackReady) {
    const list = loadSubmissions()
    const r = list.find((x) => x && String(x.id) === id)
    if (r) {
      r.teacherFeedback = r.teacherFeedback || '(교사 피드백 작성 완료)'
      r.feedbackUpdatedAt = remote.feedbackUpdatedAt || r.feedbackUpdatedAt || Date.now()
      try {
        localStorage.setItem(
          `circuit_submission_feedback_done_v1:${id}`,
          String(r.feedbackUpdatedAt || Date.now()),
        )
      } catch {
        // ignore
      }
    }
  }

  renderTeacherFeedbackStatus(root)
}

function clearBlobUrls(urls) {
  ;(urls || []).forEach((u) => revokeIfUrl(u))
}

function addFiles(kind, files) {
  const d = state.data
  const list = Array.from(files || []).filter(Boolean)
  if (!list.length) return
  if (kind === 'process') {
    d.processImgs.push(...list)
    d.processPreviewUrls.push(...list.map((f) => URL.createObjectURL(f)))
  } else if (kind === 'final') {
    d.finalImgs.push(...list)
    d.finalPreviewUrls.push(...list.map((f) => URL.createObjectURL(f)))
    state.session.finalUploadedAt = Date.now()
  }
}

function setFile(kind, file) {
  const d = state.data
  if (kind === 'circuit') {
    revokeIfUrl(d.circuitPreviewUrl)
    d.circuitImg = file
    d.circuitPreviewUrl = file ? URL.createObjectURL(file) : null
  }
}

function clearFiles(kind) {
  const d = state.data
  if (kind === 'process') {
    clearBlobUrls(d.processPreviewUrls)
    d.processImgs = []
    d.processPreviewUrls = []
  } else if (kind === 'final') {
    clearBlobUrls(d.finalPreviewUrls)
    d.finalImgs = []
    d.finalPreviewUrls = []
  }
}

function removeFileAt(kind, idx) {
  const d = state.data
  if (kind === 'process') {
    const url = d.processPreviewUrls?.[idx]
    revokeIfUrl(url)
    d.processImgs.splice(idx, 1)
    d.processPreviewUrls.splice(idx, 1)
  } else if (kind === 'final') {
    const url = d.finalPreviewUrls?.[idx]
    revokeIfUrl(url)
    d.finalImgs.splice(idx, 1)
    d.finalPreviewUrls.splice(idx, 1)
  }
}

function movePage(n) {
  state.page = n
  render()
}

const ADMIN_USERNAME =
  typeof import.meta !== 'undefined' &&
  import.meta.env &&
  typeof import.meta.env.VITE_TEACHER_USERNAME === 'string' &&
  import.meta.env.VITE_TEACHER_USERNAME.trim()
    ? import.meta.env.VITE_TEACHER_USERNAME.trim()
    : 'admin'
const ADMIN_PASSWORD =
  (typeof import.meta !== 'undefined' &&
  import.meta.env &&
  typeof import.meta.env.VITE_TEACHER_PASSWORD === 'string' &&
  import.meta.env.VITE_TEACHER_PASSWORD.trim()
    ? import.meta.env.VITE_TEACHER_PASSWORD.trim()
    : 'ys6905')

async function teacherLoginViaServer(id, password) {
  const base = getSubmissionsApiBase()
  if (!base) return null
  const loginUrl =
    import.meta.env.VITE_SUBMISSIONS_SAME_ORIGIN === 'true'
      ? `${base}/api/auth/teacher/login?mode=auth`
      : `${base}/api/auth/teacher/login`
  const r = await fetch(loginUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ id, password }),
  })
  if (!r.ok) return null
  const j = await r.json().catch(() => null)
  if (!j || typeof j !== 'object' || !j.token) return null
  return String(j.token)
}

/** @param {number} p */
function progressLabelFromPage(p) {
  const map = { 1: '시작', 2: '준비', 3: '진행', 4: '결과', 5: '보고서' }
  return map[p] ?? `페이지 ${p}`
}

function buildGlobalBar() {
  const bar = document.createElement('header')
  bar.className = 'circuit-global-bar'
  const subs = loadSubmissions()
  const lastSeen = getLastSeenCount()
  const hasNew = subs.length > lastSeen
  const teacherBtn =
    '<button type="button" class="btn btn--secondary circuit-global-bar__btn teacher-mode-btn">관리자 모드' +
    (hasNew
      ? ' <span class="circuit-global-bar__badge" aria-label="미확인 제출 있음">신규</span>'
      : '') +
    '</button>'
  /** 1페이지(표지)에서만 학습자 → 관리자 전환. 2~5페이지에서는 관리자 진입 숨김 */
  const allowTeacherFromStudent = state.page === 1
  /** 대시보드(로그인 후)에서는 학습자 모드 버튼 숨김 — 로그인 창에서만 학습자로 돌아갈 수 있음 */
  const showStudentModeInTeacherBar =
    state.teacherView && !getTeacherAuth()
  /** 관리자 대시보드: 세션 종료 후 로그인 화면으로 (상단 오른쪽) */
  const showTeacherLogout = state.teacherView && getTeacherAuth()
  const leftActionsHtml =
    state.teacherView
      ? showStudentModeInTeacherBar
        ? '<button type="button" class="btn btn--secondary circuit-global-bar__btn student-mode-btn">학습자 모드</button>'
        : ''
      : allowTeacherFromStudent
        ? teacherBtn
        : ''
  const logoutBtnHtml =
    '<button type="button" class="btn circuit-global-bar__btn teacher-logout-btn" aria-label="관리자 로그아웃">Log Out</button>'
  bar.innerHTML = showTeacherLogout
    ? `
    <div class="circuit-global-bar__inner">
      <div class="circuit-global-bar__actions circuit-global-bar__actions--end">${logoutBtnHtml}</div>
    </div>
  `
    : `
    <div class="circuit-global-bar__inner">
      <div class="circuit-global-bar__actions">${leftActionsHtml}</div>
    </div>
  `
  bar.querySelector('.teacher-mode-btn')?.addEventListener('click', () => {
    state.teacherView = true
    state.teacherSelectedId = null
    render()
  })
  bar.querySelector('.student-mode-btn')?.addEventListener('click', () => {
    state.teacherView = false
    render()
  })
  bar.querySelector('.teacher-logout-btn')?.addEventListener('click', () => {
    setTeacherAuth(false)
    setTeacherApiSessionToken('')
    state.teacherSelectedId = null
    render()
  })
  return bar
}

async function buildSubmissionRecordFromState() {
  const d = state.data
  const snap = state.journalSnapshot
  const reportRoot = document.querySelector('.circuit-page--report')
  const swot =
    snap?.swot ??
    (reportRoot ? readSwotFromReport(reportRoot) : { s: '', w: '', o: '', t: '' })
  /** @type {{ circuit?: string, final?: string[], process?: string[] }} */
  const images = {}
  if (d.circuitImg) {
    images.circuit = await fileToCompressedJpegDataUrl(d.circuitImg)
  }
  if (d.finalImgs?.length) {
    images.final = []
    for (const f of d.finalImgs) {
      images.final.push(await fileToCompressedJpegDataUrl(f))
    }
  }
  if (d.processImgs?.length) {
    images.process = []
    for (const f of d.processImgs.slice(0, 4)) {
      images.process.push(await fileToCompressedJpegDataUrl(f))
    }
  }
  return {
    id: crypto.randomUUID(),
    submittedAt: Date.now(),
    student: {
      subject: d.subject,
      date: d.date,
      dept: d.dept,
      info: d.info,
    },
    currentPage: state.page,
    progressLabel: progressLabelFromPage(state.page),
    hasCircuit: !!d.circuitImg,
    hasProcess: (d.processImgs?.length ?? 0) > 0,
    hasFinal: (d.finalImgs?.length ?? 0) > 0,
    selfEval: d.selfEval?.trim() ?? '',
    swot,
    learningMinutes: computeLearningMinutes(),
    images,
  }
}

/**
 * @param {HTMLElement} host
 * @param {import('./teacher-storage.js').SubmissionRecord[]} rows
 * @param {string} filterDept
 * @param {string} filterSubject
 * @param {boolean} onlyFinal
 */
function renderTeacherDashboard(host, rows, filterDept, filterSubject, onlyFinal) {
  const filtered = rows.filter((r) => {
    if (onlyFinal && !r.hasFinal) return false
    if (filterDept.trim()) {
      const q = filterDept.trim().toLowerCase()
      if (!String(r.student.dept || '').toLowerCase().includes(q)) return false
    }
    if (filterSubject.trim()) {
      const q = filterSubject.trim().toLowerCase()
      if (!String(r.student.subject || '').toLowerCase().includes(q)) return false
    }
    return true
  })

  let selId = state.teacherSelectedId
  if (!filtered.some((r) => r.id === selId)) {
    selId = filtered[0]?.id ?? null
  }
  state.teacherSelectedId = selId
  const detail = selId
    ? filtered.find((r) => r.id === selId) ?? null
    : null

  const didInit = host.getAttribute('data-teacher-dash-init') === '1'
  if (!didInit) {
    host.setAttribute('data-teacher-dash-init', '1')
    host.innerHTML = `
      <div class="teacher-dash">
        <header class="teacher-dash__head">
          <h1 class="teacher-dash__title">교사 Dashboard</h1>
          <p class="teacher-dash__sub">개별 피드백</p>
        </header>
        <div class="teacher-dash__grid">
          <section class="teacher-dash__list" aria-label="학습자 목록">
            <div class="teacher-dash__list-head">
              <div class="teacher-dash__filters">
                <label class="field field--inline teacher-dash__filter">
                  <span class="field__label">학과 필터</span>
                  <input type="search" class="input teacher-filter-dept" placeholder="예: 전기과" />
                </label>
                <label class="field field--inline teacher-dash__filter">
                  <span class="field__label">과목 필터</span>
                  <input type="search" class="input teacher-filter-subject" placeholder="예: 전기기능사" />
                </label>
              </div>
              <div class="teacher-dash__bulk" aria-label="제출 관리">
                <button type="button" class="btn btn--secondary teacher-bulk-toggle">전체 선택</button>
                <button type="button" class="btn btn--secondary teacher-bulk-delete" disabled>선택 삭제</button>
                <button type="button" class="btn btn--danger teacher-bulk-delete-all" disabled>전체 삭제</button>
              </div>
            </div>
            <table class="teacher-table">
              <colgroup>
                <col />
                <col />
                <col />
                <col />
                <col class="teacher-col-check" />
              </colgroup>
              <thead>
                <tr>
                  <th>학년-반-번호&nbsp;&nbsp;성명</th>
                  <th>학과</th>
                  <th>과목</th>
                  <th>제출</th>
                  <th class="teacher-table__th-check" aria-label="선택">선택</th>
                </tr>
              </thead>
              <tbody class="teacher-table__body"></tbody>
            </table>
            <p class="teacher-empty teacher-empty--list" hidden></p>
          </section>
          <section class="teacher-dash__detail" aria-label="선택한 학습자"></section>
        </div>
      </div>
    `

    const deptInput = host.querySelector('.teacher-filter-dept')
    const subjectInput = host.querySelector('.teacher-filter-subject')
    if (deptInput instanceof HTMLInputElement) {
      deptInput.value = state.teacherFilterDept
      deptInput.addEventListener('input', () => {
        state.teacherFilterDept = deptInput.value
        // 전체 화면 리렌더를 피하고, 목록/상세만 갱신해 IME 입력이 끊기지 않게 함
        renderTeacherDashboard(
          host,
          loadSubmissions(),
          state.teacherFilterDept,
          state.teacherFilterSubject,
          false,
        )
      })
    }
    if (subjectInput instanceof HTMLInputElement) {
      subjectInput.value = state.teacherFilterSubject
      subjectInput.addEventListener('input', () => {
        state.teacherFilterSubject = subjectInput.value
        renderTeacherDashboard(
          host,
          loadSubmissions(),
          state.teacherFilterDept,
          state.teacherFilterSubject,
          false,
        )
      })
    }
  }

  const deptInput = host.querySelector('.teacher-filter-dept')
  if (deptInput instanceof HTMLInputElement && deptInput.value !== filterDept) {
    deptInput.value = filterDept
  }
  const subjectInput = host.querySelector('.teacher-filter-subject')
  if (
    subjectInput instanceof HTMLInputElement &&
    subjectInput.value !== filterSubject
  ) {
    subjectInput.value = filterSubject
  }

  const bulkToggleBtn = host.querySelector('.teacher-bulk-toggle')
  const bulkDeleteBtn = host.querySelector('.teacher-bulk-delete')
  const bulkDeleteAllBtn = host.querySelector('.teacher-bulk-delete-all')

  const updateBulkUi = () => {
    const visibleIds = filtered.map((r) => r.id)
    const checkedVisibleCount = visibleIds.filter((id) =>
      state.teacherCheckedIds.has(id),
    ).length
    if (bulkToggleBtn) {
      bulkToggleBtn.textContent =
        visibleIds.length > 0 && checkedVisibleCount === visibleIds.length
          ? '전체 해제'
          : '전체 선택'
      bulkToggleBtn.toggleAttribute('disabled', visibleIds.length === 0)
    }
    bulkDeleteBtn?.toggleAttribute('disabled', checkedVisibleCount === 0)
    // 필터 결과가 없으면(표에 보이는 항목 없음) '전체 삭제'도 비활성화
    bulkDeleteAllBtn?.toggleAttribute(
      'disabled',
      rows.length === 0 || filtered.length === 0,
    )
  }

  const tbody = host.querySelector('.teacher-table__body')
  if (tbody) {
    tbody.innerHTML = filtered
      .map((r) => {
        const active = r.id === state.teacherSelectedId ? ' is-active' : ''
        const t = new Date(r.submittedAt)
        const timeStr = `${t.getMonth() + 1}/${t.getDate()} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
        const checked = state.teacherCheckedIds.has(r.id) ? ' checked' : ''
        return `<tr class="teacher-table__row${active}" data-id="${escapeHtml(r.id)}">
          <td>${escapeHtml(r.student.info || '—')}</td>
          <td>${escapeHtml(r.student.dept || '—')}</td>
          <td>${escapeHtml(r.student.subject || '—')}</td>
          <td>${timeStr}</td>
          <td class="teacher-table__td-check">
            <input type="checkbox" class="teacher-row-check" data-id="${escapeHtml(r.id)}"${checked} aria-label="제출 선택" />
          </td>
        </tr>`
      })
      .join('')
    tbody.querySelectorAll('.teacher-table__row').forEach((row) => {
      row.addEventListener('click', (e) => {
        const target = /** @type {HTMLElement | null} */ (e.target)
        if (target?.closest?.('.teacher-row-check')) return
        const id = row.getAttribute('data-id')
        if (id) {
          state.teacherSelectedId = id
          renderTeacherView(filterDept, filterSubject)
        }
      })
    })

    tbody.querySelectorAll('.teacher-row-check').forEach((el) => {
      el.addEventListener('click', (e) => e.stopPropagation())
      el.addEventListener('change', () => {
        const id = el.getAttribute('data-id')
        const checked = /** @type {HTMLInputElement} */ (el).checked
        if (!id) return
        if (checked) state.teacherCheckedIds.add(id)
        else state.teacherCheckedIds.delete(id)
        updateBulkUi()
      })
    })
  }

  if (bulkToggleBtn && !bulkToggleBtn.getAttribute('data-bound')) {
    bulkToggleBtn.setAttribute('data-bound', '1')
    bulkToggleBtn.addEventListener('click', () => {
    const visibleIds = filtered.map((r) => r.id)
    const allChecked =
      visibleIds.length > 0 &&
      visibleIds.every((id) => state.teacherCheckedIds.has(id))
    if (allChecked) {
      visibleIds.forEach((id) => state.teacherCheckedIds.delete(id))
    } else {
      visibleIds.forEach((id) => state.teacherCheckedIds.add(id))
    }
      renderTeacherDashboard(host, loadSubmissions(), filterDept, filterSubject, false)
    })
  }

  if (bulkDeleteBtn && !bulkDeleteBtn.getAttribute('data-bound')) {
    bulkDeleteBtn.setAttribute('data-bound', '1')
    bulkDeleteBtn.addEventListener('click', async () => {
    const visibleIds = filtered.map((r) => r.id)
    const targets = visibleIds.filter((id) => state.teacherCheckedIds.has(id))
    if (targets.length === 0) return
    if (!confirm(`선택된 제출 ${targets.length}개를 삭제할까요?`)) return
    for (const id of targets) {
      await removeSubmission(id)
      state.teacherCheckedIds.delete(id)
    }
    setLastSeenCount(loadSubmissions().length)
    if (targets.includes(state.teacherSelectedId ?? '')) {
      state.teacherSelectedId = null
    }
      renderTeacherDashboard(host, loadSubmissions(), filterDept, filterSubject, false)
    })
  }

  if (bulkDeleteAllBtn && !bulkDeleteAllBtn.getAttribute('data-bound')) {
    bulkDeleteAllBtn.setAttribute('data-bound', '1')
    bulkDeleteAllBtn.addEventListener('click', async () => {
    if (rows.length === 0) return
    if (!confirm(`제출된 기록 ${rows.length}개를 모두 삭제할까요?`)) return
    for (const r of rows) {
      await removeSubmission(r.id)
    }
    state.teacherCheckedIds.clear()
    state.teacherSelectedId = null
    setLastSeenCount(0)
      renderTeacherDashboard(host, loadSubmissions(), filterDept, filterSubject, false)
    })
  }

  updateBulkUi()

  const listEmptyEl = host.querySelector('.teacher-empty--list')
  if (listEmptyEl) {
    if (filtered.length === 0) {
      listEmptyEl.hidden = false
      listEmptyEl.textContent =
        '조건에 맞는 제출이 없습니다. 학습자가「교사 Dashboard에 제출」을 누르면 여기에 표시됩니다.'
    } else {
      listEmptyEl.hidden = true
      listEmptyEl.textContent = ''
    }
  }

  const detailHost = host.querySelector('.teacher-dash__detail')
  if (detailHost) {
    const deptTrim = detail ? String(detail.student.dept ?? '').trim() : ''
    const teacherTitleHtml =
      detail &&
      (deptTrim
        ? `${escapeHtml(deptTrim)} ${escapeHtml(detail.student.info || '(이름 없음)')}`
        : escapeHtml(detail.student.info || '(이름 없음)'))
    detailHost.innerHTML = !detail
      ? '<p class="teacher-empty">목록에서 학습자를 선택하세요.</p>'
      : `
        <h2 class="teacher-detail__name">${teacherTitleHtml}</h2>
        <p class="teacher-detail__meta">${escapeHtml(formatPracticeDateKorean(detail.student.date))} · ${escapeHtml(detail.student.subject || '')}</p>
        <div class="teacher-detail__cols">
          <div class="teacher-detail__col">
            <h3>회로도</h3>
            <div class="teacher-detail__img teacher-detail__img--circuit"></div>
          </div>
          <div class="teacher-detail__col">
            <h3>최종 결과</h3>
            <div class="teacher-detail__img teacher-detail__img--final"></div>
          </div>
        </div>
        <div class="teacher-swot">
          <h3>SWOT (제출 시점)</h3>
          <ul class="teacher-swot__list ai-output">
            <li><strong>S</strong> ${escapeHtml(detail.swot?.s || '')}</li>
            <li><strong>W</strong> ${escapeHtml(detail.swot?.w || '')}</li>
            <li><strong>O</strong> ${escapeHtml(detail.swot?.o || '')}</li>
            <li><strong>T</strong> ${escapeHtml(detail.swot?.t || '')}</li>
          </ul>
        </div>
        <label class="field field--block">
          <span class="field__label">자기평가</span>
          <div class="teacher-readonly">${escapeHtml(detail.selfEval || '(없음)')}</div>
        </label>
        <label class="field field--block">
          <div class="teacher-field-head">
            <span class="field__label">교사 피드백</span>
            <button type="button" class="btn btn--sm btn--ghost teacher-feedback-reset">Reset</button>
          </div>
          <textarea class="input input--area teacher-feedback-input ai-output" rows="6" placeholder="이 학습자에게 보낼 피드백을 입력하세요."></textarea>
        </label>
        <div class="teacher-detail__actions">
          <button type="button" class="btn btn--secondary teacher-ai-btn">AI 피드백 초안 생성</button>
          <button type="button" class="btn btn--primary teacher-save-btn">피드백 저장</button>
        </div>
        <p class="teacher-detail__msg" hidden></p>
      `
  }

  if (detail) {
    const circuitEl = host.querySelector('.teacher-detail__img--circuit')
    const finalEl = host.querySelector('.teacher-detail__img--final')
    if (circuitEl) {
      circuitEl.innerHTML = detail.images?.circuit
        ? `<img src="${detail.images.circuit}" alt="회로도" />`
        : '<span class="teacher-no-img">없음</span>'
    }
    if (finalEl) {
      const first = detail.images?.final?.[0]
      finalEl.innerHTML = first
        ? `<img src="${first}" alt="최종 결과" />`
        : '<span class="teacher-no-img">없음</span>'
    }
    const ta = host.querySelector('.teacher-feedback-input')
    if (ta instanceof HTMLTextAreaElement) {
      ta.value = detail.teacherFeedback ?? ''
    }
    const msg = host.querySelector('.teacher-detail__msg')
    const aiBtn = host.querySelector('.teacher-ai-btn')
    const saveBtn = host.querySelector('.teacher-save-btn')
    const resetBtn = host.querySelector('.teacher-feedback-reset')

    aiBtn?.addEventListener('click', async () => {
      if (!(ta instanceof HTMLTextAreaElement) || !msg) return
      msg.hidden = false
      const useApi = isOpenAiProxyAvailable()
      const context = `학습자: ${detail.student.info}, 학과: ${detail.student.dept}, 과목: ${detail.student.subject}
SWOT S/W/O/T: ${detail.swot?.s || ''} / ${detail.swot?.w || ''} / ${detail.swot?.o || ''} / ${detail.swot?.t || ''}
자기평가: ${detail.selfEval || ''}`
      if (!useApi) {
        msg.className = 'info-banner teacher-detail__msg'
        msg.textContent =
          '개발 서버(OpenAI 프록시)가 없어 짧은 안내만 넣습니다. 실제 초안은 API 연결 후 생성하세요.'
        ta.value =
          `[모의 초안] 아래 제출 내용만을 근거로 검토해 주세요. 제출에 없는 배선·단자 상태는 단정하지 않습니다.\n` +
          `- 강점/보완은 학습자가 적은 SWOT·자기평가에 맞춰 한두 가지씩만 언급\n` +
          `- 안전: 작업 전 전원 확인·배선 재점검을 한 문장으로 안내`
        return
      }
      aiBtn.disabled = true
      msg.className = 'success-msg teacher-detail__msg'
      msg.textContent = 'AI가 초안을 작성 중입니다…'
      try {
        const draft = await sendOpenAiChat(
          [
            {
              role: 'user',
              content:
                `다음은 학습자 제출에서 확인되는 사실만이다. 제출에 없는 회로 세부·단자·측정값을 지어내지 말고, 확인된 내용만으로 교사가 학생에게 줄 짧은 피드백 초안(한국어, 3~6문장)을 작성해줘.\n\n` +
                `근거가 매우 적으면 "제출 내용만으로는 구체 피드백이 어렵습니다"로 시작하고, 추가로 필요한 자료를 1~2문장으로만 요청해줘.\n\n` +
                context,
            },
          ],
          '교사용 개별 피드백 초안',
          undefined,
          { skipRefine: true },
        )
        ta.value = draft
        msg.textContent = '초안을 입력란에 넣었습니다. 검토 후 저장하세요.'
      } catch (e) {
        msg.className = 'info-banner teacher-detail__msg'
        msg.textContent =
          e instanceof Error ? e.message : 'AI 요청에 실패했습니다.'
        // API 오류 시에도 교사가 바로 수정할 수 있도록 모의 초안을 넣는다.
        ta.value =
          `[모의 초안] API 오류로 자동 생성에 실패했습니다. 아래는 형식용 문장이며 실제 관찰에 기반하지 않을 수 있습니다.\n` +
          `제출된 SWOT·자기평가·사진을 다시 확인한 뒤 직접 피드백을 작성해 주세요.`
      } finally {
        aiBtn.disabled = false
      }
    })

    resetBtn?.addEventListener('click', () => {
      if (!(ta instanceof HTMLTextAreaElement)) return
      ta.value = ''
      ta.focus()
    })

    saveBtn?.addEventListener('click', async () => {
      if (!(ta instanceof HTMLTextAreaElement) || !msg) return
      let ok = false
      try {
        ok = await updateSubmissionFeedback(detail.id, ta.value.trim())
      } catch {
        ok = false
      }
      msg.hidden = false
      msg.className = ok ? 'success-msg teacher-detail__msg' : 'info-banner teacher-detail__msg'
      msg.textContent = ok
        ? isRemoteSubmissionsEnabled()
          ? '피드백이 저장되었고 동기화 서버에 반영되었습니다.'
          : '피드백이 이 브라우저에 저장되었습니다.'
        : '저장에 실패했습니다.'
    })
  }
}

function renderTeacherView(
  filterDept = state.teacherFilterDept,
  filterSubject = state.teacherFilterSubject,
) {
  const app = document.getElementById('app')
  if (!app) return
  app.innerHTML = ''
  app.className = 'circuit-app circuit-app--shell'
  app.appendChild(buildGlobalBar())
  const pageHost = document.createElement('div')
  pageHost.className = 'circuit-page-host'
  app.appendChild(pageHost)

  if (!getTeacherAuth()) {
    pageHost.innerHTML = `
      <div class="teacher-gate">
        <header class="cover-brand">
          <p class="cover-brand__eyebrow">Circuit Lab Journal</p>
          <h1 class="circuit-title">전기 실습일지 <span class="circuit-title__en">Show me the circuit</span></h1>
          <p class="circuit-subtitle">관리자 모드</p>
        </header>
        <p class="teacher-gate__lead teacher-gate__lead--small">관리자 아이디, 비밀번호를 입력하세요.</p>
        <label class="field field--block">
          <span class="field__label">아이디</span>
          <input type="text" class="input teacher-gate__id" autocomplete="username" />
        </label>
        <label class="field field--block">
          <span class="field__label">비밀번호</span>
          <input type="password" class="input teacher-gate__pw" autocomplete="current-password" />
        </label>
        <button type="button" class="btn btn--primary teacher-gate__go">확인</button>
        <p class="teacher-gate__err info-banner" hidden></p>
      </div>`
    const idEl = pageHost.querySelector('.teacher-gate__id')
    const pw = pageHost.querySelector('.teacher-gate__pw')
    const err = pageHost.querySelector('.teacher-gate__err')
    const goBtn = pageHost.querySelector('.teacher-gate__go')
    const tryLogin = async () => {
      const id = idEl instanceof HTMLInputElement ? idEl.value.trim() : ''
      const v = pw instanceof HTMLInputElement ? pw.value : ''
      if (err) err.hidden = true

      // 원격 서버가 있으면, 교사 로그인은 서버가 토큰을 발급(브라우저에 비밀번호 노출 최소화)
      const serverToken = await teacherLoginViaServer(id, v)
      if (serverToken) {
        setTeacherApiSessionToken(serverToken)
        setTeacherAuth(true)
        setLastSeenCount(loadSubmissions().length)
        initTeacherStorage()
          .catch(() => {})
          .finally(() => render())
        return
      }

      // 원격 서버가 없으면(로컬 모드) 기존 방식으로만 로그인
      if (id === ADMIN_USERNAME && v === ADMIN_PASSWORD) {
        setTeacherAuth(true)
        setLastSeenCount(loadSubmissions().length)
        render()
        return
      }

      if (err) {
        err.hidden = false
        err.textContent = '아이디 또는 비밀번호가 올바르지 않습니다.'
      }
    }
    goBtn?.addEventListener('click', tryLogin)
    const onEnter = (e) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      tryLogin()
    }
    if (idEl instanceof HTMLInputElement) idEl.addEventListener('keydown', onEnter)
    if (pw instanceof HTMLInputElement) pw.addEventListener('keydown', onEnter)
    return
  }

  pageHost.innerHTML =
    '<p class="teacher-gate__lead teacher-gate__lead--small">제출 목록을 불러오는 중…</p>'
  void initTeacherStorage()
    .catch(() => {})
    .finally(() => {
      setLastSeenCount(loadSubmissions().length)
      renderTeacherDashboard(
        pageHost,
        loadSubmissions(),
        filterDept,
        filterSubject,
        false,
      )
    })
}

function totalUploadedImageCount() {
  const d = state.data
  return (
    (d.circuitPreviewUrl ? 1 : 0) +
    (d.processPreviewUrls?.length ?? 0) +
    (d.finalPreviewUrls?.length ?? 0)
  )
}

function computeLearningMinutes() {
  const start = state.session.startedAt
  const end = state.session.finalUploadedAt
  if (!start || !end || end < start) return null
  return Math.max(1, Math.round((end - start) / 60000))
}

function mountPage(app, pageRoot) {
  app.appendChild(pageRoot)
}

/** host: 페이지 루트. options.navParent 가 있으면 내비는 그 요소 안에만 붙음(보고서 출력 카드 등). */
function attachPageNav(host, options = {}) {
  if (state.page <= 1 || !host) return
  const nav = document.createElement('div')
  nav.className = 'circuit-page-nav'
  nav.setAttribute('role', 'group')
  nav.setAttribute('aria-label', '페이지 이동')

  const prevBtn = document.createElement('button')
  prevBtn.type = 'button'
  prevBtn.className =
    'btn btn--secondary circuit-page-nav__btn circuit-page-nav__prev'
  prevBtn.textContent = '이전 페이지'
  prevBtn.title = '이전 단계로 돌아갑니다'
  prevBtn.setAttribute('aria-label', '이전 페이지로 이동')
  prevBtn.addEventListener('click', () => movePage(state.page - 1))

  const actions = document.createElement('div')
  actions.className = 'circuit-page-nav__actions'
  actions.appendChild(prevBtn)

  if (state.page < 5) {
    const nextBtn = document.createElement('button')
    nextBtn.type = 'button'
    nextBtn.className =
      'btn btn--primary circuit-page-nav__btn circuit-page-nav__next'
    nextBtn.textContent = '다음 페이지'
    nextBtn.title = '다음 단계로 이동합니다'
    nextBtn.setAttribute('aria-label', '다음 페이지로 이동')
    nextBtn.addEventListener('click', () => movePage(state.page + 1))
    actions.appendChild(nextBtn)
  }

  nav.appendChild(actions)
  const navHost =
    options.navParent ??
    (host?.classList?.contains('ai-chat')
      ? host.querySelector('.ai-chat__footer') ?? host
      : host)
  navHost.appendChild(nav)
}

function mockAiReply(contextDescription) {
  return `[모의 응답] 지금은 API에 연결되지 않아 실제 분석을 할 수 없습니다. ${contextDescription} 단계에서는 회로도·실습 사진을 올리고 질문을 구체적으로 적으면 도움이 됩니다.`
}

function isDeployTight() {
  return (
    import.meta.env.VITE_NETLIFY_DEPLOY === 'true' || import.meta.env.PROD === true
  )
}

function aiInstructionForPage(contextDescription, hasImages = true) {
  const subject = String(state.data.subject || '').trim()
  const dept = String(state.data.dept || '').trim()
  const info = String(state.data.info || '').trim()
  const page = state.page
  const stage =
    page === 2
      ? '준비(회로도/재료 확인)'
      : page === 3
        ? '진행(도면 대비 결선/배선 상태 점검)'
        : page === 4
          ? '결과(동작/배선 품질/안전/미관 점검)'
          : '기타'

  const sparseBlock = !hasImages
    ? `
중요(이미지 없음):
- 이번 요청에는 분석용 회로도/실습 사진이 첨부되어 있지 않습니다. 특정 단자·배선·부품 상태를 단정하거나 '확인했다'처럼 쓰지 마세요.
- 일반 안전·실습 진행 팁과, 구체 답을 위해 필요한 사진/정보(무엇을 어떻게 찍을지)만 짧게(6문장 이내) 안내하세요.
`
    : ''

  return `다음은 전기 실습 이미지 정밀 분석 요청입니다.
정확성이 최우선입니다. 이미지·대화에 없는 사실은 쓰지 마세요. 확인한 내용만 쓰고, 각 주장에 (근거: ○○)를 붙이세요.
회로도와 실습 사진이 모두 있으면 도면과 실물을 반드시 대조하세요.
학습자는 전기 지식이 부족할 수 있습니다. 어려운 말은 쉽게 풀어서, 할 일 순서대로 안내하세요. 분량은 각 항목 2~4문장으로 짧게, 1)~5)는 모두 완결하세요.
${sparseBlock}
맥락:
- 단계: ${stage}
- 과목: ${subject || '(미입력)'}
- 학과/학습자: ${dept || '(미입력)'} / ${info || '(미입력)'}
- 현재 단계 설명: ${contextDescription || ''}

분석 지시:
- 첨부된 이미지(회로도/실습 사진)에서 텍스트·단자번호·기호를 최대한 읽어 근거로 삼아라. (예: NO/NC/COM, A1/A2, 13-14/21-22, 코일/접점, MCCB/퓨즈, 단자대 번호, 배선 색상)
- 회로도와 사진을 비교해서 불일치/오결선 후보를 우선순위로 제시하고, 각 후보의 '판단 근거(이미지에서 확인한 포인트)'를 함께 써라.
- 위험 요소(감전/단락/과열) 가능성이 있으면 가장 먼저 안전 조치를 제시하고, 그 다음 점검 순서를 체크리스트로 제시하라.
- 이미지에서 확실히 안 보이는 라벨/단자/연결은 추측하지 말고, 확인 질문(1~3개)으로 좁혀라.

추가 규칙(이미지가 불명확할 때):
- 글자/단자번호/접점 표기가 흐리거나 가려져 핵심 판단이 어려우면, 먼저 "추가 사진이 필요"하다고 말하고 아래 항목 중 필요한 것만 골라 3~6개 요청하라.
  - 단자대(번호가 보이게) 정면 근접 1장
  - 릴레이/타이머/접촉기: 모델명 라벨 + 단자(A1/A2, 13-14, 21-22 등)가 동시에 보이게 1장
  - MCCB/퓨즈/전원부: 입력/출력 배선이 보이게 1장
  - 센서/스위치: NO/NC/COM 표기가 보이게 1장
  - 전체 배선 샷 1장(배선 경로가 이어지게)
- 각 요청마다 "어디를/어떤 각도로/어떤 거리로" 찍어야 하는지 1문장 촬영 가이드를 붙여라. (예: 플래시 끄고, 그림자 피하고, 글자 초점 맞추기, 카메라를 단자면과 평행하게)
`
}

function takeLastFiles(files, n) {
  const arr = Array.isArray(files) ? files.filter(Boolean) : []
  return arr.slice(Math.max(0, arr.length - n))
}

/** API 전송용: 최근 대화만 포함해 페이로드·타임아웃 방지 */
function trimMessagesForApi(messages, maxMessages = 14) {
  const arr = Array.isArray(messages) ? messages : []
  if (arr.length <= maxMessages) return arr
  return arr.slice(-maxMessages)
}

function buildPracticeContextForAi() {
  const d = state.data || {}
  const materialCounts = d.materialCounts || {}
  const materialsTop = Object.entries(materialCounts)
    .filter(([, v]) => Number(v) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 10)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ')

  const imgs = {
    circuit: d.circuitImg ? 1 : 0,
    process: Array.isArray(d.processImgs) ? d.processImgs.length : 0,
    final: Array.isArray(d.finalImgs) ? d.finalImgs.length : 0,
  }

  return `실습 데이터 요약:
- 재료(수량 입력 상위): ${materialsTop || '(없음)'}
- 업로드 수: 회로도 ${imgs.circuit}장, 진행 ${imgs.process}장, 최종 ${imgs.final}장
- 자기평가(있다면 참고): ${String(d.selfEval || '').trim() || '(없음)'}
`
}

async function buildAiImagesForChat() {
  /** @type {{ dataUrl: string, label?: string }[]} */
  const images = []
  const deployTight = isDeployTight()
  const circuitMaxW = deployTight ? 1408 : 2048
  const circuitQuality = deployTight ? 0.8 : 0.9
  const photoMaxW = deployTight ? 1280 : 1800
  const photoQuality = deployTight ? 0.76 : 0.88
  const photoMax = deployTight ? 2 : 4

  // 회로도는 모든 단계에서 가장 중요한 기준이므로 항상(있으면) 포함
  if (state.data.circuitImg) {
    images.push({
      label: '회로도(기준 도면)',
      dataUrl: await fileToCompressedJpegDataUrl(
        state.data.circuitImg,
        circuitMaxW,
        circuitQuality,
      ),
    })
  }

  // 단계별로 관련 실습 사진(최근 N장) — 도면 대비·배선 피드백에 필요
  if (state.page === 3) {
    const recent = takeLastFiles(state.data.processImgs, photoMax)
    for (let i = 0; i < recent.length; i++) {
      const f = recent[i]
      images.push({
        label: `실습 진행 사진(최근 ${i + 1}/${recent.length})`,
        dataUrl: await fileToCompressedJpegDataUrl(f, photoMaxW, photoQuality),
      })
    }
  }
  if (state.page === 4) {
    const recent = takeLastFiles(state.data.finalImgs, photoMax)
    for (let i = 0; i < recent.length; i++) {
      const f = recent[i]
      images.push({
        label: `최종 결과 사진(최근 ${i + 1}/${recent.length})`,
        dataUrl: await fileToCompressedJpegDataUrl(f, photoMaxW, photoQuality),
      })
    }
  }
  return images
}

async function sendChatMessage(
  contextDescription,
  inputEl,
  messagesEl,
  sendBtn,
) {
  const text = inputEl.value.trim()
  if (!text) return
  inputEl.value = ''
  state.messages.push({ role: 'user', content: text })
  renderChatMessages(messagesEl)
  scrollChatToBottom(messagesEl)

  const useApi = isOpenAiProxyAvailable()
  if (!useApi) {
    state.messages.push({
      role: 'assistant',
      content: mockAiReply(contextDescription),
    })
    renderChatMessages(messagesEl)
    scrollChatToBottom(messagesEl)
    return
  }

  sendBtn.disabled = true
  inputEl.disabled = true
  sendBtn.classList.add('btn--loading')
  renderChatMessages(messagesEl, { pendingAssistant: true })
  scrollChatToBottom(messagesEl)
  try {
    const images = await buildAiImagesForChat()
    const hasImages = images.length > 0
    const instruction = `${aiInstructionForPage(contextDescription, hasImages)}\n${buildPracticeContextForAi()}`
    const messagesForAi = [
      { role: 'user', content: instruction },
      ...trimMessagesForApi(state.messages, 12),
    ]
    let statusEl = messagesEl.querySelector('.chat-pending-text')
    const reply = await sendOpenAiChat(messagesForAi, contextDescription, images, {
      skipRefine: true,
      onStatus: (msg) => {
        if (!statusEl) {
          statusEl = messagesEl.querySelector('.chat-pending-text')
        }
        if (statusEl) statusEl.textContent = msg
      },
    })
    state.messages.push({ role: 'assistant', content: reply })
  } catch (e) {
    const msg =
      e instanceof Error ? e.message : '요청에 실패했습니다.'
    const isQuotaError =
      /exceeded your current quota/i.test(msg) ||
      /insufficient[_\s-]?quota/i.test(msg) ||
      /billing/i.test(msg)
    const isTimeoutError =
      /Inactivity Timeout|응답 시간이 초과|일시적으로 응답하지 않|서버 한도|빈 응답/i.test(
        msg,
      )
    state.messages.push({
      role: 'assistant',
      content: isQuotaError
        ? `현재 OpenAI API 쿼터(크레딧)가 부족해 실시간 응답을 받을 수 없습니다.\n\n대신 모의 응답으로 계속 진행합니다.\n\n(해결: OpenAI 콘솔에서 결제/크레딧을 확인하고 .env의 OPENAI_API_KEY 설정 후 dev 서버를 재시작하세요.)`
        : isTimeoutError
          ? `${msg}\n\n(분석에 20~30초 걸릴 수 있습니다. 잠시만 기다려 주세요. 같은 오류가 반복되면 Netlify에 GEMINI_CHAT_MODEL=gemini-2.5-flash 가 설정됐는지 확인해 주세요.)`
          : `오류: ${msg}`,
    })
    if (isQuotaError) {
      state.messages.push({
        role: 'assistant',
        content: mockAiReply(contextDescription),
      })
    }
  } finally {
    sendBtn.disabled = false
    inputEl.disabled = false
    sendBtn.classList.remove('btn--loading')
  }
  renderChatMessages(messagesEl)
  scrollChatToBottom(messagesEl)
}

function scrollChatToBottom(container) {
  if (!container) return
  requestAnimationFrame(() => {
    container.scrollTop = container.scrollHeight
  })
}

/**
 * @param {HTMLElement | null} container
 * @param {{ pendingAssistant?: boolean }} [opts]
 */
function renderChatMessages(container, opts = {}) {
  if (!container) return
  const pending = Boolean(opts.pendingAssistant)
  const turns = state.messages
    .map((m) => {
      const roleLabel = m.role === 'user' ? 'USER' : 'Circuit AI'
      const avatar =
        m.role === 'user'
          ? `<div class="chat-turn__avatar" aria-hidden="true">나</div>`
          : `<div class="chat-turn__avatar" aria-hidden="true"></div>`
      return `<article class="chat-turn chat-turn--${m.role}" aria-label="${roleLabel} 메시지">
      ${avatar}
      <div class="chat-turn__column">
        <span class="chat-turn__label">${roleLabel}</span>
        <div class="chat-bubble chat-bubble--${m.role}">
          <div class="chat-bubble__content">${renderMarkdownLiteToHtml(m.content)}</div>
        </div>
      </div>
    </article>`
    })
    .join('')
  const pendingHtml = pending
    ? `<article class="chat-turn chat-turn--assistant chat-turn--pending" aria-busy="true" aria-live="polite" aria-label="Circuit AI 답변 생성 중">
      <div class="chat-turn__avatar" aria-hidden="true"></div>
      <div class="chat-turn__column">
        <span class="chat-turn__label">Circuit AI</span>
        <div class="chat-bubble chat-bubble--assistant chat-bubble--pending">
          <div class="chat-bubble__content chat-bubble__content--pending">
            <span class="chat-spinner" aria-hidden="true"></span>
            <span class="chat-pending-text">답변을 생성하는 중…</span>
          </div>
        </div>
      </div>
    </article>`
    : ''
  container.innerHTML = turns + pendingHtml
}

function renderAiChatbot(contextDescription) {
  const wrap = document.createElement('div')
  wrap.className = 'ai-chat'
  wrap.innerHTML = `
    <div class="ai-chat__head">
      <span class="ai-chat__badge">AI</span>
      <div class="ai-chat__head-text">
        <h2 class="ai-chat__title">Circuit Chatbot</h2>
      </div>
    </div>
    <div class="info-banner"><span class="info-banner__k">현재 단계</span>${escapeHtml(contextDescription)}</div>
    <div class="chat-messages" aria-live="polite"></div>
    <div class="ai-chat__footer">
      <div class="chat-input-row">
        <input type="text" class="chat-input" placeholder="예: 이 회로 쉽게 설명해줘 (회로도 업로드 후)" autocomplete="off" />
        <button type="button" class="btn btn--primary chat-send">전송</button>
      </div>
    </div>
  `
  const messagesEl = wrap.querySelector('.chat-messages')
  const inputEl = wrap.querySelector('.chat-input')
  const sendBtn = wrap.querySelector('.chat-send')

  const starters = document.createElement('div')
  starters.className = 'ai-chat__starters'
  starters.setAttribute('aria-label', '질문 예시')
  ;[
    '회로도와 실습 사진 비교해서 오결선 후보 알려줘',
    '지금 배선 상태 점검 순서 알려줘',
    '안전하게 확인할 항목만 짧게 정리해줘',
  ].forEach((q) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'btn btn--chip ai-chat__starter'
    b.textContent = q
    starters.appendChild(b)
  })
  messagesEl.before(starters)

  renderChatMessages(messagesEl)
  const submit = () =>
    sendChatMessage(contextDescription, inputEl, messagesEl, sendBtn)
  sendBtn.addEventListener('click', submit)
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) submit()
  })
  starters.querySelectorAll('.ai-chat__starter').forEach((btn) => {
    btn.addEventListener('click', () => {
      inputEl.value = btn.textContent?.trim() || ''
      inputEl.focus()
      submit()
    })
  })
  return wrap
}

function progressHtml() {
  const labels = ['시작', '준비', '진행', '결과', '보고서']
  const p = state.page
  const items = labels
    .map((label, i) => {
      const step = i + 1
      let cls = 'circuit-progress__item'
      if (p === step) cls += ' is-current'
      else if (p > step) cls += ' is-complete'
      else cls += ' is-todo'
      return `<div class="${cls}"><span class="circuit-progress__dot" aria-hidden="true">${step}</span><span class="circuit-progress__label">${label}</span></div>`
    })
    .join('')
  return `<nav class="circuit-progress" aria-label="진행 단계">${items}</nav>`
}

function renderSidebar() {
  const d = state.data
  const el = document.createElement('aside')
  el.className = 'circuit-sidebar'
  const dateIso = /^\d{4}-\d{2}-\d{2}$/.test(String(d.date || '').trim())
    ? String(d.date).trim()
    : ''
  el.innerHTML = `<span class="circuit-sidebar__icon" aria-hidden="true"></span><span class="circuit-sidebar__text"><span class="circuit-sidebar__main"><strong>${escapeHtml(d.subject || '과목 미선택')}</strong><span class="circuit-sidebar__sep">·</span><span>${escapeHtml(d.dept?.trim() || '학과 미입력')}</span><span class="circuit-sidebar__sep">·</span><span>${escapeHtml(d.info || '성명 입력 전')}</span></span><time class="circuit-sidebar__date"${dateIso ? ` datetime="${escapeHtml(dateIso)}"` : ''}>${escapeHtml(formatPracticeDateKorean(d.date))}</time></span>`
  return el
}

function render() {
  const app = document.getElementById('app')
  if (state.teacherView) {
    renderTeacherView('')
    return
  }

  app.innerHTML = ''
  app.className = 'circuit-app circuit-app--shell'
  app.appendChild(buildGlobalBar())
  const pageHost = document.createElement('div')
  pageHost.className = 'circuit-page-host'
  app.appendChild(pageHost)

  if (state.page === 1) {
    const root = document.createElement('div')
    root.className = 'circuit-page circuit-page--cover'
    root.innerHTML = `
      ${progressHtml()}
      <header class="cover-brand">
        <p class="cover-brand__eyebrow">Circuit Lab Journal</p>
        <h1 class="circuit-title">전기 실습일지 <span class="circuit-title__en">Show me the circuit</span></h1>
        <p class="circuit-subtitle">실습 과목과 인적사항을 입력하세요.</p>
      </header>
      <div class="cover-card">
        <p class="cover-card__lead">오늘 실습할 과목</p>
        <div class="btn-row btn-row--3">
          <button type="button" class="btn btn--chip subject-btn" data-subject="승강기기능사">승강기기능사</button>
          <button type="button" class="btn btn--chip subject-btn" data-subject="전기기능사">전기기능사</button>
          <button type="button" class="btn btn--chip subject-btn" data-subject="철도전기신호기능사">철도전기신호기능사</button>
        </div>
        <hr class="divider" />
        <div class="field-row field-row--3">
          <label class="field"><span class="field__label">실습 날짜</span><input type="date" class="input date-input" /></label>
          <label class="field"><span class="field__label">학과명</span><input type="text" class="input dept-input" placeholder="예: 전기과" /></label>
          <label class="field"><span class="field__label">학년-반-번호  성명</span><input type="text" class="input info-input" placeholder="예: 1-1-01 홍길동" /></label>
        </div>
        <button type="button" class="btn btn--primary btn--lg next-btn" disabled>다음 페이지</button>
      </div>
    `
    const dateInput = root.querySelector('.date-input')
    const deptInput = root.querySelector('.dept-input')
    const infoInput = root.querySelector('.info-input')
    const nextBtn = root.querySelector('.next-btn')

    dateInput.value = state.data.date
    deptInput.value = state.data.dept
    infoInput.value = state.data.info

    const syncData = () => {
      state.data.date = dateInput.value
      state.data.dept = deptInput.value.trim()
      state.data.info = infoInput.value.trim()
      const ok =
        state.data.subject &&
        state.data.dept &&
        state.data.info
      nextBtn.disabled = !ok
    }

    root.querySelectorAll('.subject-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.data.subject = btn.dataset.subject
        root.querySelectorAll('.subject-btn').forEach((b) =>
          b.classList.toggle('btn--active', b === btn),
        )
        syncData()
      })
    })
    if (state.data.subject) {
      root.querySelectorAll('.subject-btn').forEach((b) => {
        if (b.dataset.subject === state.data.subject) b.classList.add('btn--active')
      })
    }

    ;[dateInput, deptInput, infoInput].forEach((el) =>
      el.addEventListener('input', syncData),
    )
    nextBtn.addEventListener('click', () => {
      if (!state.session.startedAt) state.session.startedAt = Date.now()
      movePage(2)
    })
    syncData()
    mountPage(pageHost, root)
    return
  }

  if (state.page === 2) {
    const wrap = document.createElement('div')
    wrap.className = 'circuit-page circuit-page--step'
    wrap.innerHTML = progressHtml()
    wrap.appendChild(renderSidebar())

    const mainCol = document.createElement('div')
    mainCol.className = 'circuit-workspace'
    mainCol.innerHTML = `
      <div class="panel panel--main panel--prepare">
        <p class="panel__step">Step 1</p>
        <h1 class="step-title">실습 준비</h1>
        <p class="step-lede">사용 재료와 회로 도면을 남겨 두면 이후 단계와 AI 피드백에 참고됩니다.</p>
        <div class="prepare-narrow">
          <label class="field field--block"><span class="field__label">오늘 사용할 재료</span>
            <div class="materials-list" role="group" aria-label="사용 재료 수량 입력">
              ${MATERIAL_ITEMS.map(
                (name) => `
                <div class="materials-item">
                  <span class="materials-name">${escapeHtml(name)}</span>
                  <input type="number" inputmode="numeric" min="0" max="999" step="1" class="input materials-qty" data-material="${escapeHtml(name)}" />
                </div>
              `,
              ).join('')}
            </div>
          </label>
          <h2 class="section-title section-title--upload">회로 도면 업로드</h2>
          <label class="file-drop">
            <input type="file" accept="image/png,image/jpeg,image/jpg" class="file-circuit file-input-native" />
            <span class="file-drop__inner">
              <span class="file-drop__placeholder">
                <span class="file-drop__icon" aria-hidden="true"></span>
                <span class="file-drop__title">이미지를 끌어 놓거나 눌러 선택</span>
                <span class="file-drop__hint">PNG, JPG · 최대 화면에 맞게 미리보기</span>
              </span>
              <div class="preview-wrap circuit-preview file-drop__preview"></div>
            </span>
          </label>
          <div class="btn-row btn-row--right">
            <button type="button" class="btn btn--danger btn--sm del-circuit">업로드 삭제</button>
          </div>
          <button type="button" class="btn btn--primary btn--lg step-next">실습 시작하기</button>
        </div>
      </div>
    `
    const counts = state.data.materialCounts || (state.data.materialCounts = defaultMaterialCounts())
    mainCol.querySelectorAll('.materials-qty').forEach((el) => {
      const key = el.dataset.material
      el.value = String(Math.max(0, Number(counts?.[key] ?? 0) || 0))
      el.addEventListener('input', () => {
        const n = Math.max(0, Math.min(999, Number(el.value) || 0))
        el.value = String(n)
        state.data.materialCounts[key] = n
      })
    })
    mainCol.querySelector('.file-circuit').addEventListener('change', (e) => {
      const f = e.target.files?.[0]
      setFile('circuit', f || null)
      render()
    })
    mainCol.querySelector('.del-circuit').addEventListener('click', () => {
      setFile('circuit', null)
      mainCol.querySelector('.file-circuit').value = ''
      render()
    })
    const prev = mainCol.querySelector('.circuit-preview')
    const dropCircuit = prev?.closest('.file-drop')
    if (state.data.circuitPreviewUrl) {
      prev.innerHTML = `<img src="${state.data.circuitPreviewUrl}" alt="업로드된 회로도" class="preview-img" />`
      dropCircuit?.classList.add('file-drop--has-preview')
    } else {
      prev.innerHTML = ''
      dropCircuit?.classList.remove('file-drop--has-preview')
    }
    mainCol.querySelector('.step-next').addEventListener('click', () =>
      movePage(3),
    )

    const row = document.createElement('div')
    row.className = 'circuit-columns'
    row.appendChild(mainCol)
    const aiCol = document.createElement('div')
    aiCol.className = 'circuit-ai'
    const aiChatEl = renderAiChatbot('회로도 분석 및 안전사항 안내')
    aiCol.appendChild(aiChatEl)
    attachPageNav(aiChatEl)
    row.appendChild(aiCol)
    wrap.appendChild(row)
    mountPage(pageHost, wrap)
    return
  }

  if (state.page === 3) {
    const wrap = document.createElement('div')
    wrap.className = 'circuit-page circuit-page--step'
    wrap.innerHTML = progressHtml()
    wrap.appendChild(renderSidebar())
    const mainCol = document.createElement('div')
    mainCol.className = 'circuit-workspace'
    mainCol.innerHTML = `
      <div class="panel panel--main">
        <p class="panel__step">Step 2</p>
        <h1 class="step-title">실습 진행 중</h1>
        <p class="step-lede">중간 과정 사진을 남기면 도면과의 차이를 AI가 함께 짚어 줍니다.</p>
        <h2 class="section-title section-title--upload">중간 과정 사진 업로드</h2>
        <label class="file-drop">
          <input type="file" accept="image/png,image/jpeg,image/jpg" class="file-process file-input-native" multiple />
          <span class="file-drop__inner">
            <span class="file-drop__placeholder">
              <span class="file-drop__icon" aria-hidden="true"></span>
              <span class="file-drop__title">이미지를 끌어 놓거나 눌러 선택</span>
              <span class="file-drop__hint">PNG, JPG · 최대 화면에 맞게 미리보기</span>
            </span>
            <div class="preview-wrap process-preview file-drop__preview"></div>
          </span>
        </label>
        <div class="btn-row btn-row--right">
          <button type="button" class="btn btn--outline-blue btn--sm add-process">추가 업로드</button>
          <button type="button" class="btn btn--danger btn--sm del-process">업로드 삭제</button>
        </div>
        <div class="upload-gallery upload-gallery--process" aria-label="업로드된 중간 과정 목록"></div>
        <button type="button" class="btn btn--primary btn--lg step-next">최종 완성 단계로 이동</button>
      </div>
    `
    const fileInput = mainCol.querySelector('.file-process')
    fileInput.addEventListener('change', (e) => {
      addFiles('process', e.target.files)
      fileInput.value = ''
      render()
    })
    mainCol.querySelector('.del-process').addEventListener('click', () => {
      clearFiles('process')
      render()
    })
    mainCol.querySelector('.add-process').addEventListener('click', () => {
      fileInput.click()
    })
    const prev = mainCol.querySelector('.process-preview')
    const dropProcess = prev?.closest('.file-drop')
    const urls = state.data.processPreviewUrls || []
    if (urls.length) {
      const last = urls[urls.length - 1]
      prev.innerHTML = `<img src="${last}" alt="실습 진행" class="preview-img" />`
      dropProcess?.classList.add('file-drop--has-preview')
    } else {
      prev.innerHTML = ''
      dropProcess?.classList.remove('file-drop--has-preview')
    }
    const gallery = mainCol.querySelector('.upload-gallery--process')
    gallery.innerHTML = urls.length
      ? `<div class="upload-gallery__grid">${urls
          .map(
            (u, i) => `
          <figure class="upload-thumb">
            <img src="${u}" alt="중간 과정 ${i + 1}" />
            <button type="button" class="upload-thumb__del" data-idx="${i}" aria-label="삭제">×</button>
          </figure>
        `,
          )
          .join('')}</div>`
      : `<p class="upload-gallery__empty">(업로드된 파일 없음)</p>`
    gallery.querySelectorAll('.upload-thumb__del').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.idx)
        if (Number.isFinite(idx)) removeFileAt('process', idx)
        render()
      })
    })
    mainCol.querySelector('.step-next').addEventListener('click', () =>
      movePage(4),
    )
    const row = document.createElement('div')
    row.className = 'circuit-columns'
    row.appendChild(mainCol)
    const aiCol = document.createElement('div')
    aiCol.className = 'circuit-ai'
    const aiChatEl = renderAiChatbot('도면과 실습 사진 비교 분석 중')
    aiCol.appendChild(aiChatEl)
    attachPageNav(aiChatEl)
    row.appendChild(aiCol)
    wrap.appendChild(row)
    mountPage(pageHost, wrap)
    return
  }

  if (state.page === 4) {
    const wrap = document.createElement('div')
    wrap.className = 'circuit-page circuit-page--step'
    wrap.innerHTML = progressHtml()
    wrap.appendChild(renderSidebar())
    const mainCol = document.createElement('div')
    mainCol.className = 'circuit-workspace'
    mainCol.innerHTML = `
      <div class="panel panel--main">
        <p class="panel__step">Step 3</p>
        <h1 class="step-title">최종 결과물</h1>
        <p class="step-lede">완성 사진을 올리면 동작·배선 상태에 대한 피드백을 받을 수 있습니다.</p>
        <h2 class="section-title section-title--upload">최종 결과 사진 업로드</h2>
        <label class="file-drop">
          <input type="file" accept="image/png,image/jpeg,image/jpg" class="file-final file-input-native" multiple />
          <span class="file-drop__inner">
            <span class="file-drop__placeholder">
              <span class="file-drop__icon" aria-hidden="true"></span>
              <span class="file-drop__title">이미지를 끌어 놓거나 눌러 선택</span>
              <span class="file-drop__hint">PNG, JPG · 최대 화면에 맞게 미리보기</span>
            </span>
            <div class="preview-wrap final-preview file-drop__preview"></div>
          </span>
        </label>
        <div class="btn-row btn-row--right">
          <button type="button" class="btn btn--outline-blue btn--sm add-final">추가 업로드</button>
          <button type="button" class="btn btn--danger btn--sm del-final">업로드 삭제</button>
        </div>
        <div class="upload-gallery upload-gallery--final" aria-label="업로드된 최종 결과 목록"></div>
        <button type="button" class="btn btn--primary btn--lg step-next">실습일지 정리 및 분석</button>
      </div>
    `
    const fileInput = mainCol.querySelector('.file-final')
    fileInput.addEventListener('change', (e) => {
      addFiles('final', e.target.files)
      fileInput.value = ''
      render()
    })
    mainCol.querySelector('.del-final').addEventListener('click', () => {
      clearFiles('final')
      render()
    })
    mainCol.querySelector('.add-final').addEventListener('click', () => {
      fileInput.click()
    })
    const prev = mainCol.querySelector('.final-preview')
    const dropFinal = prev?.closest('.file-drop')
    const urls = state.data.finalPreviewUrls || []
    if (urls.length) {
      const last = urls[urls.length - 1]
      prev.innerHTML = `<img src="${last}" alt="최종 완성" class="preview-img" />`
      dropFinal?.classList.add('file-drop--has-preview')
    } else {
      prev.innerHTML = ''
      dropFinal?.classList.remove('file-drop--has-preview')
    }
    const gallery = mainCol.querySelector('.upload-gallery--final')
    gallery.innerHTML = urls.length
      ? `<div class="upload-gallery__grid">${urls
          .map(
            (u, i) => `
          <figure class="upload-thumb">
            <img src="${u}" alt="최종 결과 ${i + 1}" />
            <button type="button" class="upload-thumb__del" data-idx="${i}" aria-label="삭제">×</button>
          </figure>
        `,
          )
          .join('')}</div>`
      : `<p class="upload-gallery__empty">(업로드된 파일 없음)</p>`
    gallery.querySelectorAll('.upload-thumb__del').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.idx)
        if (Number.isFinite(idx)) removeFileAt('final', idx)
        render()
      })
    })
    mainCol.querySelector('.step-next').addEventListener('click', () =>
      movePage(5),
    )
    const row = document.createElement('div')
    row.className = 'circuit-columns'
    row.appendChild(mainCol)
    const aiCol = document.createElement('div')
    aiCol.className = 'circuit-ai'
    const aiChatEl = renderAiChatbot('최종 결과물 동작 여부 및 미관 피드백')
    aiCol.appendChild(aiChatEl)
    attachPageNav(aiChatEl)
    row.appendChild(aiCol)
    wrap.appendChild(row)
    mountPage(pageHost, wrap)
    return
  }

  if (state.page === 5) {
    const root = document.createElement('div')
    root.className = 'circuit-page circuit-page--report'
    const snapSwot = state.journalSnapshot?.swot
    const swotS = snapSwot?.s || '—'
    const swotW = snapSwot?.w || '—'
    const swotO = snapSwot?.o || '—'
    const swotT = snapSwot?.t || '—'
    const aiSummary = state.journalSnapshot?.aiSummary || ''
    root.innerHTML = `
      ${progressHtml()}
      <header class="report-header">
        <p class="report-header__eyebrow">Summary</p>
        <h1 class="report-header__title">최종 실습 결과 보고서</h1>
        <p class="report-header__sub">AI 요약과 자기평가를 한곳에서 정리합니다.</p>
      </header>
      <div class="report-grid">
        <section class="report-card">
          <h2 class="report-card__title"><span class="report-card__num">01</span>실습 데이터 종합</h2>
          <dl class="stat-list">
            <div class="stat-list__row"><dt>학습 시간</dt><dd>${(() => {
              const mins = computeLearningMinutes()
              return mins ? `약 ${mins}분` : `<span class="stat-list__note">(측정 전)</span>`
            })()}</dd></div>
            <div class="stat-list__row"><dt>이미지 업로드</dt><dd>${totalUploadedImageCount()}장</dd></div>
          </dl>
          <div class="info-banner info-banner--soft ai-summary-banner ai-output">${escapeHtml(aiSummary || 'AI 종합 피드백은 「최종 실습일지 생성」을 누르면 자동으로 채워집니다.')}</div>
          <hr class="divider" />
          <div class="report-self-eval">
            <h3 class="report-card__subtitle">자기평가</h3>
            <textarea class="input input--area self-eval-input" rows="3" placeholder="오늘 실습에 대한 나의 평가를 적어 주세요."></textarea>
            <button type="button" class="btn btn--secondary self-eval-btn">자기평가 제출</button>
            <p class="self-eval-msg" hidden></p>
          </div>
        </section>
        <section class="report-card report-card--accent">
          <h2 class="report-card__title"><span class="report-card__num">02</span>SWOT 분석 <span class="report-card__tag">AI</span></h2>
          <ul class="swot-list">
            <li><span class="swot-list__k">S</span><span><strong>Strength</strong> · <span class="swot-list__v ai-output" data-k="s">${escapeHtml(swotS)}</span></span></li>
            <li><span class="swot-list__k">W</span><span><strong>Weakness</strong> · <span class="swot-list__v ai-output" data-k="w">${escapeHtml(swotW)}</span></span></li>
            <li><span class="swot-list__k">O</span><span><strong>Opportunity</strong> · <span class="swot-list__v ai-output" data-k="o">${escapeHtml(swotO)}</span></span></li>
            <li><span class="swot-list__k">T</span><span><strong>Threat</strong> · <span class="swot-list__v ai-output" data-k="t">${escapeHtml(swotT)}</span></span></li>
          </ul>
          <button type="button" class="btn btn--primary btn--block final-report-btn">최종 실습일지 생성</button>
          <p class="balloons-msg" hidden></p>
        </section>
        <section class="report-card report-card--export">
          <h2 class="report-card__title"><span class="report-card__num">03</span>보고서 출력</h2>
          <p class="report-card__p">입력·업로드한 내용이 포함된 PDF를 내보냅니다.</p>
          <button type="button" class="btn btn--secondary btn--block pdf-btn">PDF 내보내기</button>
          <p class="pdf-msg" hidden></p>
          <hr class="divider divider--tight" />
          <h3 class="report-card__subtitle">교사 공유</h3>
          <p class="report-card__p report-card__p--small">교사 Dashboard에 제출을 누르면 선생님의 피드백을 받을 수 있습니다.</p>
          ${
            isRemoteSubmissionsEnabled()
              ? ''
              : '<p class="info-banner report-sync-hint">이 주소에서는 제출이 이 기기·브라우저에만 저장됩니다. 수업 전체 공유는 배포 URL 또는 선생님 PC의 개발 서버(같은 Wi‑Fi)를 사용하세요.</p>'
          }
          <button type="button" class="btn btn--outline-blue btn--block submit-teacher-btn">교사 Dashboard에 제출</button>
          <p class="submit-teacher-msg" hidden></p>
          <p class="teacher-feedback-status info-banner info-banner--soft" aria-live="polite"></p>
        </section>
      </div>
      <button type="button" class="btn btn--secondary btn--block restart-btn">처음으로 돌아가기</button>
    `
    const reportHeader = root.querySelector('.report-header')
    if (reportHeader) root.insertBefore(renderSidebar(), reportHeader)

    const selfEvalInput = root.querySelector('.self-eval-input')
    if (selfEvalInput) {
      selfEvalInput.value = state.data.selfEval ?? ''
      selfEvalInput.addEventListener('input', () => {
        state.data.selfEval = selfEvalInput.value
      })
    }

    root.querySelector('.self-eval-btn').addEventListener('click', () => {
      state.data.selfEval = selfEvalInput?.value ?? ''
      const msg = root.querySelector('.self-eval-msg')
      msg.hidden = false
      msg.textContent = '자기평가가 저장되었습니다.'
      msg.className = 'success-msg'
    })

    root.querySelector('.final-report-btn').addEventListener('click', async () => {
      const msg = root.querySelector('.balloons-msg')
      msg.hidden = false
      msg.className = 'info-banner'
      msg.textContent = 'Circuit Chatbot 피드백을 바탕으로 SWOT/종합 피드백을 만드는 중입니다…'

      state.data.selfEval = selfEvalInput?.value?.trim() ?? ''
      let swot = readSwotFromReport(root)
      let aiSummaryText = ''

      // 입력/업로드가 하나도 없으면 "실습일지 생성"을 막습니다.
      const normalizeSwot = (v) => {
        const s = String(v || '').replace(/\s+/g, ' ').trim()
        return !s || s === '—' ? '' : s
      }
      const swotHasAny =
        Boolean(normalizeSwot(swot?.s)) ||
        Boolean(normalizeSwot(swot?.w)) ||
        Boolean(normalizeSwot(swot?.o)) ||
        Boolean(normalizeSwot(swot?.t))
      const selfEvalHasAny = Boolean(String(state.data.selfEval || '').trim())
      const uploads = totalUploadedImageCount()
      if (!swotHasAny && !selfEvalHasAny && uploads === 0) {
        state.journalSnapshot = null
        msg.className = 'info-banner'
        msg.textContent =
          '아직 입력된 내용이 없습니다. 회로도/사진을 업로드하거나 자기평가를 입력한 뒤 「최종 실습일지 생성」을 눌러 주세요.'
        return
      }

      try {
        const insights = await generateAiReportInsights({ swot })
        if (insights?.swot) {
          swot = insights.swot
          aiSummaryText = insights.summary || ''
        }
      } catch {
        // 실패 시 기존(화면 값) 유지
      }

      // 화면에 반영
      const setSwot = (k, v) => {
        const el = root.querySelector(`.swot-list__v[data-k="${k}"]`)
        if (el) el.textContent = v || '—'
      }
      setSwot('s', swot?.s || '')
      setSwot('w', swot?.w || '')
      setSwot('o', swot?.o || '')
      setSwot('t', swot?.t || '')
      const banner = root.querySelector('.ai-summary-banner')
      if (banner && aiSummaryText) banner.textContent = aiSummaryText

      state.journalSnapshot = {
        swot,
        selfEval: state.data.selfEval,
        aiSummary: aiSummaryText,
      }

      msg.hidden = false
      msg.className = 'success-msg'
      msg.textContent =
        '실습일지가 저장되었습니다. 이어서 PDF 내보내기를 누르면 최종 실습일지(PDF)가 만들어집니다.'
    })

    root.querySelector('.pdf-btn').addEventListener('click', async () => {
      const msg = root.querySelector('.pdf-msg')
      msg.hidden = false
      if (!state.journalSnapshot) {
        msg.className = 'info-banner'
        msg.textContent =
          '먼저「최종 실습일지 생성」을 실행한 뒤 PDF를 내보내 주세요.'
        return
      }
      msg.className = 'success-msg'
      msg.textContent = 'PDF를 만들고 있습니다…'
      const mount = ensureJournalPdfMount()
      mount.innerHTML = ''
      const snap = state.journalSnapshot
      let teacherFeedback = ''
      try {
        const lastId = getLastSubmissionIdForCurrentStudent()
        if (lastId) {
          const rec = loadSubmissions().find((r) => r.id === lastId)
          teacherFeedback = rec?.teacherFeedback ?? ''
        }
      } catch {
        teacherFeedback = ''
      }
      const pdfEl = buildJournalPdfElement({
        data: state.data,
        materialItems: MATERIAL_ITEMS,
        swot: snap.swot,
        selfEval: snap.selfEval,
        teacherFeedback,
        learningMinutes: computeLearningMinutes(),
      })
      mount.appendChild(pdfEl)
      try {
        const stem = /^\d{4}-\d{2}-\d{2}$/.test(String(state.data.date).trim())
          ? String(state.data.date).trim()
          : '실습일지'
        await saveElementAsPdf(pdfEl, `전기실습일지-${stem}.pdf`)
        msg.textContent = 'PDF 파일로 저장했습니다.'
      } catch (e) {
        msg.className = 'info-banner'
        msg.textContent =
          e instanceof Error
            ? e.message
            : 'PDF를 저장하지 못했습니다.'
      } finally {
        mount.innerHTML = ''
      }
    })
    root.querySelector('.restart-btn').addEventListener('click', () => {
      state.page = 1
      state.messages = []
      state.journalSnapshot = null
      state.session = { startedAt: null, finalUploadedAt: null, teacherSubmittedId: null }
      state.data = {
        subject: '',
        date: new Date().toISOString().slice(0, 10),
        dept: '',
        info: '',
        materialCounts: defaultMaterialCounts(),
        circuitImg: null,
        circuitPreviewUrl: null,
        processImgs: [],
        processPreviewUrls: [],
        finalImgs: [],
        finalPreviewUrls: [],
        selfEval: '',
      }
      // 재시작 시(다음 학생), 전역 last-submission(구버전) 때문에 이전 학생 피드백 상태가 노출되지 않도록 제거
      try {
        localStorage.removeItem(LAST_SUBMISSION_ID_KEY)
      } catch {
        // ignore
      }
      render()
    })
    root.querySelector('.submit-teacher-btn')?.addEventListener('click', async () => {
      const msg = root.querySelector('.submit-teacher-msg')
      if (!msg) return
      msg.hidden = false
      msg.className = 'success-msg submit-teacher-msg'
      msg.textContent = '이미지를 압축해 제출하는 중입니다…'
      try {
        const rec = await buildSubmissionRecordFromState()
        const saved = await upsertSubmission(rec)
        state.session.teacherSubmittedId = saved?.id || null
        setLastSubmissionIdForCurrentStudent(saved.id)
        msg.textContent = isRemoteSubmissionsEnabled()
          ? '제출이 서버에 반영되었습니다. 다른 기기에서도 관리자 모드로 확인할 수 있습니다.'
          : '관리자 모드에 반영되었습니다.'
        renderTeacherFeedbackStatus(root)
      } catch (e) {
        msg.className = 'info-banner submit-teacher-msg'
        msg.textContent =
          e instanceof Error ? e.message : '제출에 실패했습니다.'
      }
    })

    mountPage(pageHost, root)
    renderTeacherFeedbackStatus(root)
    // 원격 동기화 서버가 있으면, 피드백 상태를 주기적으로 확인(작성 완료 시 자동 갱신)
    refreshTeacherFeedbackStatusFromServer(root).catch(() => {})
    const pollMs = 15000
    const timer = setInterval(() => {
      // 페이지가 바뀌었으면 중단
      if (state.page !== 5) {
        clearInterval(timer)
        return
      }
      refreshTeacherFeedbackStatusFromServer(root).catch(() => {})
    }, pollMs)
    const exportCard = root.querySelector('.report-card--export')
    attachPageNav(root, exportCard ? { navParent: exportCard } : {})
  }
}

// 원격 목록 동기화는 교사 모드(로그인 후)에서만 수행합니다.
if (getTeacherAuth()) {
  initTeacherStorage()
    .catch(() => {})
    .finally(() => render())
} else {
  render()
}

// 프로그램/탭 종료 시 관리자 세션 자동 해제 (학생이 관리자 모드에 접근하지 못하도록)
window.addEventListener('beforeunload', () => {
  try {
    setTeacherAuth(false)
  } catch {
    // ignore
  }
})
