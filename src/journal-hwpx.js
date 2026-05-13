import JSZip from 'jszip'

const HWPX_TEMPLATE_URL = '/templates/practice-journal.hwpx'
const EMPTY_RUN = '<hp:run charPrIDRef="0"/>'
const SECTION_PATH = 'Contents/section0.xml'

/** @param {string} s */
export function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 첫 페이지 date input(YYYY-MM-DD) → 실습일지 표기용 */
export function formatPracticeDateKorean(iso) {
  const s = String(iso ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '날짜 미선택'
  const [y, m, d] = s.split('-').map(Number)
  return `${y}년 ${m}월 ${d}일`
}

/**
 * @param {string} info "학년-반-번호  성명" 한 필드 값
 * @returns {{ classLine: string, name: string }}
 */
export function splitClassAndName(info) {
  const t = String(info ?? '').trim()
  if (!t) return { classLine: '', name: '' }
  const parts = t.split(/\s+/)
  if (parts.length >= 2) {
    return {
      classLine: parts.slice(0, -1).join(' '),
      name: parts[parts.length - 1] ?? '',
    }
  }
  return { classLine: t, name: '' }
}

/**
 * @param {Record<string, number>} counts
 * @param {string[]} materialItems
 */
export function formatMaterialsList(counts, materialItems) {
  const lines = []
  for (const name of materialItems) {
    const n = Math.max(0, Number(counts?.[name]) || 0)
    if (n > 0) lines.push(`${name} ${n}개`)
  }
  return lines.length ? lines.join(', ') : '(기재 없음)'
}

/**
 * @param {{
 *   subject: string
 *   date: string
 *   dept: string
 *   info: string
 *   materialCounts: Record<string, number>
 *   circuitImg: File | null
 *   processImgs?: File[]
 *   finalImgs?: File[]
 * }} data
 * @param {string[]} materialItems
 * @param {{ s: string, w: string, o: string, t: string }} swot
 * @param {string} selfEval
 * @returns {string[]} 양식 `practice-journal.hwpx` 비어 있는 run 13개와 동일 순서
 */
export function buildHwpxFillValues(data, materialItems, swot, selfEval) {
  const mats = formatMaterialsList(data.materialCounts, materialItems)
  const circuit = data.circuitImg
    ? `${data.circuitImg.name} (이미지 첨부)`
    : '(회로도 미첨부)'
  const actParts = []
  const proc = Array.isArray(data.processImgs) ? data.processImgs : []
  const fin = Array.isArray(data.finalImgs) ? data.finalImgs : []
  if (proc.length)
    actParts.push(
      `중간 과정: ${proc.length}장 (${proc.map((f) => f.name).join(', ')})`,
    )
  if (fin.length)
    actParts.push(
      `최종 결과: ${fin.length}장 (${fin.map((f) => f.name).join(', ')})`,
    )
  if (!actParts.length) actParts.push('(사진 미첨부)')
  const activity = actParts.join(' / ')
  const infoLine = data.info?.trim() || '(미입력)'

  return [
    formatPracticeDateKorean(data.date),
    data.subject?.trim() || '(과목 미선택)',
    data.dept?.trim() || '(미입력)',
    infoLine,
    mats,
    circuit,
    activity,
    swot.s?.trim() || '',
    swot.w?.trim() || '',
    swot.o?.trim() || '',
    swot.t?.trim() || '',
    selfEval?.trim() || '(미작성)',
    '',
  ]
}

/**
 * @param {string} sectionXml
 * @param {string[]} values 비어 있는 `<hp:run charPrIDRef="0"/>` 개수와 같아야 함
 */
export function fillHwpxSection0(sectionXml, values) {
  let i = 0
  return sectionXml.replaceAll(EMPTY_RUN, () => {
    const raw = values[i++] ?? ''
    const t = escapeXml(raw)
    return `<hp:run charPrIDRef="0"><hp:t>${t}</hp:t></hp:run>`
  })
}

/**
 * @param {Blob} hwpxBlob
 * @param {string} filename
 */
export function triggerDownloadBlob(hwpxBlob, filename) {
  const url = URL.createObjectURL(hwpxBlob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/**
 * @param {string[]} values
 * @returns {Promise<Blob>}
 */
export async function buildFilledHwpxBlob(values) {
  const res = await fetch(HWPX_TEMPLATE_URL)
  if (!res.ok) throw new Error(`양식을 불러오지 못했습니다. (${res.status})`)
  const input = await res.arrayBuffer()
  const zip = await JSZip.loadAsync(input)
  const entry = zip.file(SECTION_PATH)
  if (!entry) throw new Error('HWPX에 section0.xml이 없습니다.')
  const xml = await entry.async('string')
  const filled = fillHwpxSection0(xml, values)
  zip.file(SECTION_PATH, filled)
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
}
