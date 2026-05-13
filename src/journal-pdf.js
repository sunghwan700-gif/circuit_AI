import html2canvas from 'html2canvas'
import { jsPDF } from 'jspdf'
import {
  formatPracticeDateKorean,
  splitClassAndName,
  formatMaterialsList,
} from './journal-hwpx.js'

/**
 * @param {HTMLElement} source
 * @param {string} filename
 */
export async function saveElementAsPdf(source, filename) {
  const canvas = await html2canvas(source, {
    scale: 2,
    useCORS: true,
    logging: false,
    windowWidth: source.scrollWidth,
    windowHeight: source.scrollHeight,
  })

  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  })

  const marginX = 10
  const marginY = 10
  const pageW = pdf.internal.pageSize.getWidth()
  const pageH = pdf.internal.pageSize.getHeight()
  const imgW = pageW - marginX * 2
  const pageInnerH = pageH - marginY * 2

  // 캔버스를 페이지 높이(px)만큼 슬라이스해서 페이지별로 추가 (겹침 방지)
  const pxPerMm = canvas.width / imgW
  const pageInnerHPx = Math.floor(pageInnerH * pxPerMm)
  const totalPages = Math.max(1, Math.ceil(canvas.height / pageInnerHPx))

  const pageCanvas = document.createElement('canvas')
  pageCanvas.width = canvas.width
  const pageCtx = pageCanvas.getContext('2d')
  if (!pageCtx) throw new Error('PDF 이미지를 생성할 수 없습니다. (canvas context 실패)')

  for (let page = 0; page < totalPages; page++) {
    const sy = page * pageInnerHPx
    const sliceH = Math.min(pageInnerHPx, canvas.height - sy)

    pageCanvas.height = sliceH
    pageCtx.clearRect(0, 0, pageCanvas.width, sliceH)
    pageCtx.drawImage(
      canvas,
      0,
      sy,
      canvas.width,
      sliceH,
      0,
      0,
      canvas.width,
      sliceH,
    )

    const imgData = pageCanvas.toDataURL('image/png')
    const sliceHmm = (sliceH * imgW) / canvas.width

    if (page > 0) pdf.addPage()
    pdf.addImage(imgData, 'PNG', marginX, marginY, imgW, sliceHmm)
  }

  pdf.save(filename)
}

/**
 * @param {{
 *   data: object
 *   materialItems: string[]
 *   swot: { s: string, w: string, o: string, t: string }
 *   selfEval: string
 *   teacherFeedback?: string
 *   learningMinutes?: number | null
 * }} opts
 */
export function buildJournalPdfElement(opts) {
  const { data, materialItems, swot, selfEval, teacherFeedback, learningMinutes } = opts
  const { classLine, name } = splitClassAndName(data.info)
  const mats = formatMaterialsList(data.materialCounts, materialItems)
  const el = document.createElement('div')
  el.className = 'journal-pdf'
  el.setAttribute('lang', 'ko')

  const esc = (s) => {
    const d = document.createElement('div')
    d.textContent = s
    return d.innerHTML
  }

  const imgRow = (label, urls) => {
    const list = Array.isArray(urls) ? urls : urls ? [urls] : []
    if (!list.length)
      return `<div class="journal-pdf__imgrow"><strong>${esc(label)}</strong><p class="journal-pdf__muted">(미첨부)</p></div>`
    return `<div class="journal-pdf__imgrow"><strong>${esc(label)}</strong><div class="journal-pdf__imggrid">${list
      .map((u) => `<img src="${u}" alt="" crossorigin="anonymous" />`)
      .join('')}</div></div>`
  }

  el.innerHTML = `
    <h1 class="journal-pdf__title">전기 실습일지</h1>
    <p class="journal-pdf__meta">${esc(formatPracticeDateKorean(data.date))}</p>
    <table class="journal-pdf__table">
      <tr>
        <th>실습 과목</th>
        <td>${esc(data.subject || '(미선택)')}</td>
        <th>학습 시간</th>
        <td>${learningMinutes ? esc(`약 ${learningMinutes}분`) : '<span class="journal-pdf__muted">(측정 전)</span>'}</td>
      </tr>
      <tr><th>학과</th><td colspan="3">${esc(data.dept?.trim() || '학과 미입력')}</td></tr>
      <tr><th>학년-반-번호</th><td>${esc(classLine || '(미입력)')}</td><th>성명</th><td>${esc(name || '(미입력)')}</td></tr>
      <tr><th>실습 재료</th><td colspan="3">${esc(mats)}</td></tr>
      <tr><th colspan="4" class="journal-pdf__th-multi">실습 활동</th></tr>
      <tr><td colspan="4" class="journal-pdf__cell-nopad">
        ${imgRow('회로 도면', data.circuitPreviewUrl)}
        ${imgRow('실습 진행', data.processPreviewUrls)}
        ${imgRow('최종 결과', data.finalPreviewUrls)}
      </td></tr>
      <tr><th colspan="4" class="journal-pdf__th-multi">결과 분석 (SWOT)</th></tr>
      <tr><td colspan="4">
        <p><strong>S</strong> ${esc(swot.s)}</p>
        <p><strong>W</strong> ${esc(swot.w)}</p>
        <p><strong>O</strong> ${esc(swot.o)}</p>
        <p><strong>T</strong> ${esc(swot.t)}</p>
      </td></tr>
      <tr><th colspan="4">자기 평가 및 계획</th></tr>
      <tr><td colspan="4"><div class="journal-pdf__block">${esc(selfEval || '(미작성)')}</div></td></tr>
      <tr><th colspan="4">교사 평가</th></tr>
      <tr><td colspan="4"><div class="journal-pdf__block${teacherFeedback?.trim() ? '' : ' journal-pdf__muted'}">${esc(teacherFeedback?.trim() || '(작성 전)')}</div></td></tr>
    </table>
  `
  return el
}
