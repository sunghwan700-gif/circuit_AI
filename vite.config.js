import { resolve } from 'path'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [
      {
        name: 'openai-chat-proxy',
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            const pathname = req.url?.split('?')[0] || ''
            if (pathname !== '/api/openai/chat' || req.method !== 'POST') {
              next()
              return
            }

            const buf = await readBody(req)
            let body
            try {
              body = JSON.parse(buf.toString('utf8') || '{}')
            } catch {
              res.statusCode = 400
              res.setHeader('Content-Type', 'application/json; charset=utf-8')
              res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }))
              return
            }

            const { messages, contextDescription, images, skipRefine: skipRefineBody } =
              body
            // Gemini(구글 AI Studio) 키를 사용합니다.
            // - 권장: GEMINI_API_KEY 또는 GOOGLE_API_KEY
            // - (호환) 기존 OPENAI_API_KEY에 넣어둔 경우도 fallback
            const key = (
              env.GEMINI_API_KEY ||
              env.GOOGLE_API_KEY ||
              env.OPENAI_API_KEY ||
              ''
            ).trim()
            if (!key) {
              res.statusCode = 500
              res.setHeader('Content-Type', 'application/json; charset=utf-8')
              res.end(
                JSON.stringify({
                  error: {
                    message:
                      '.env에 GEMINI_API_KEY(또는 GOOGLE_API_KEY)가 없습니다. 저장 후 dev 서버를 재시작하세요.',
                  },
                }),
              )
              return
            }

            // Gemini 모델명 예: gemini-2.5-pro, gemini-2.5-flash
            // (호환) 사용자가 models/gemini-... 형태로 넣어도 동작하도록 정규화
            const normalizeModel = (m) => String(m || '').replace(/^models\//, '').trim()
            const primaryModel = (
              env.GEMINI_MODEL ||
              env.GOOGLE_MODEL ||
              // 더 정밀한 기본값: Pro 계열을 우선 사용(비용/속도는 증가할 수 있음)
              'gemini-2.5-pro'
            ).trim()
            const fallbackModels = String(
              env.GEMINI_FALLBACK_MODELS ||
                // 2.0-flash는 신규 사용자에게 막힐 수 있어 최신 모델을 기본으로 둡니다.
                'gemini-2.5-pro,gemini-2.5-flash,gemini-3-flash-preview',
            )
              .split(',')
              .map((s) => normalizeModel(s))
              .filter(Boolean)
            const modelCandidates = Array.from(
              new Set([normalizeModel(primaryModel), ...fallbackModels]),
            )
            const imageList = Array.isArray(images) ? images : []
            const hasImages = imageList.length > 0
            const systemContent = `당신은 전기 실습(회로·승강기·철도전기신호 등)을 돕는 조교입니다. 항상 한국어로 답합니다.

공통 원칙(가장 중요):
- 환각 금지: 이미지에서 읽지 못한 단자 번호·배선·표기·측정값을 '확인했다'처럼 쓰지 마세요. 없는 사실을 만들어내지 마세요.
- 근거 분리: 확인된 사실 / 추정(가정) / 모름 을 구분해 말하세요.
- 자료가 없으면 짧게: 이번 요청에 분석용 회로도·실습 사진이 첨부되지 않았거나 대화에 구체적 내용이 없으면, 일반 안전 원칙과 '무엇을 올리면 다음에 구체적으로 도울 수 있는지'만 2~6문장으로 안내하세요. 구체 회로 진단을 꾸며 내지 마세요.
- 불확실하면 질문: 핵심 정보가 부족하면 결론을 길게 내리지 말고 확인 질문 1~3개만 하세요.
- 안전 우선: 감전·단락·과열 가능성이 거론되면 전원 차단을 먼저 말하세요.

${
              hasImages
                ? `이번 요청에는 이미지가 포함되어 있습니다. 이미지에서 실제로 보이는 텍스트·단자·배선·표기를 근거로 정밀히 설명하세요.

답변 형식(근거가 충분할 때 위주로 유지, 근거가 부족하면 짧게 줄여도 됨):
1) 결론 요약
2) 관찰/근거 (이미지·대화에서 확인한 점만)
3) 분석 (원인 후보는 근거가 있을 때만, 우선순위)
4) 점검/조치 순서 (체크리스트, 안전 포함)
5) 추가 확인 질문 (필요 시)`
                : `이번 요청에는 분석용 이미지가 첨부되어 있지 않습니다. 위 '자료가 없으면 짧게' 규칙을 따르세요. 장문의 가상 점검 결과를 쓰지 마세요.`
            }

현재 실습 단계 맥락: ${contextDescription || ''}`

            try {
              const contents = (Array.isArray(messages) ? messages : []).map((m) => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: String(m.content ?? '') }],
              }))

              // 이미지(데이터 URL)를 마지막 user turn에 첨부 (Gemini 멀티모달)
              if (imageList.length) {
                const toInlinePart = (img) => {
                  const dataUrl = String(img?.dataUrl || '')
                  const m = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl)
                  if (!m) return null
                  const mimeType = m[1] || 'image/jpeg'
                  const data = m[2] || ''
                  if (!data) return null
                  return { inlineData: { mimeType, data } }
                }

                let lastUserIdx = -1
                for (let i = contents.length - 1; i >= 0; i--) {
                  if (contents[i]?.role === 'user') {
                    lastUserIdx = i
                    break
                  }
                }
                if (lastUserIdx < 0) {
                  contents.push({
                    role: 'user',
                    parts: [{ text: '' }],
                  })
                  lastUserIdx = contents.length - 1
                }

                const attachNote = imageList
                  .map((img, i) => String(img?.label || `이미지 ${i + 1}`))
                  .filter(Boolean)
                  .join(', ')
                contents[lastUserIdx].parts.unshift({
                  text: attachNote
                    ? `첨부 이미지(${attachNote})를 함께 분석해 답변해줘.`
                    : '첨부 이미지를 함께 분석해 답변해줘.',
                })

                for (const img of imageList) {
                  const part = toInlinePart(img)
                  if (part) contents[lastUserIdx].parts.push(part)
                }
              }

              const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
              const backoffMs = [250, 750, 1500]

              let lastStatus = 500
              let lastMessage = '요청에 실패했습니다.'
              let rawText = ''
              let usedModel = ''

              const extractTextAndFinish = (raw) => {
                let data
                try {
                  data = JSON.parse(raw)
                } catch {
                  return { text: '', finishReason: '' }
                }
                const parts = data.candidates?.[0]?.content?.parts
                const text = Array.isArray(parts)
                  ? parts
                      .map((p) => (typeof p?.text === 'string' ? p.text : ''))
                      .join('')
                      .trim()
                  : ''
                const finishReason = String(data.candidates?.[0]?.finishReason || '').trim()
                return { text, finishReason }
              }

              const callGemini = async (model, contentsToSend) => {
                const r = await fetch(
                  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
                    model,
                  )}:generateContent`,
                  {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'x-goog-api-key': key,
                    },
                    body: JSON.stringify({
                      systemInstruction: {
                        role: 'system',
                        parts: [{ text: systemContent }],
                      },
                      contents: contentsToSend,
                      generationConfig: {
                        // 분석 품질/일관성 강화: 과한 랜덤성 억제
                        temperature: 0.25,
                        topP: 0.9,
                        // 답변이 중간에서 끊기는 현상 방지: 출력 토큰을 크게 확보
                        // (모델별 상한이 있어 과하면 서버가 오류를 반환할 수 있음)
                        maxOutputTokens: 6144,
                      },
                    }),
                  },
                )
                return r
              }

              for (const model of modelCandidates) {
                for (let attempt = 0; attempt < backoffMs.length + 1; attempt++) {
                  const r = await callGemini(model, contents)

                  rawText = await r.text()
                  if (r.ok) {
                    lastStatus = 200
                    lastMessage = ''
                    usedModel = model
                    break
                  }

                  lastStatus = r.status || 500
                  let msg = rawText
                  try {
                    const j = JSON.parse(rawText)
                    msg = j.error?.message || j.error || rawText
                  } catch {
                    /* ignore */
                  }
                  lastMessage = String(msg || rawText || '요청에 실패했습니다.')

                  // 과부하/레이트리밋 계열은 재시도/모델 폴백을 시도
                  const shouldRetry =
                    lastStatus === 429 ||
                    lastStatus === 503 ||
                    /high demand|overloaded|try again later|RESOURCE_EXHAUSTED/i.test(
                      lastMessage,
                    )

                  if (shouldRetry && attempt < backoffMs.length) {
                    await sleep(backoffMs[attempt])
                    continue
                  }

                  // 재시도 대상이 아니면 즉시 종료
                  break
                }

                if (lastStatus === 200) break
              }

              if (lastStatus !== 200) {
                const friendly =
                  /high demand|overloaded|try again later|RESOURCE_EXHAUSTED/i.test(
                    lastMessage,
                  )
                    ? '현재 Gemini 모델이 과부하 상태입니다(일시적). 잠시 후 다시 시도하거나, 다른 모델로 바꿔보세요.\n\n해결: .env에 GEMINI_MODEL=gemini-2.5-flash (또는 gemini-3-flash-preview) 를 넣거나, GEMINI_FALLBACK_MODELS에 여러 모델을 콤마로 지정할 수 있습니다.'
                    : lastMessage
                res.statusCode = lastStatus
                res.setHeader('Content-Type', 'application/json; charset=utf-8')
                res.end(JSON.stringify({ error: { message: friendly } }))
                return
              }

              // 응답이 MAX_TOKENS로 끊기면 자동으로 이어쓰기(continue) 호출을 반복해 한 번에 합쳐서 반환
              const maxContinues = 4
              let out = ''
              let finishReason = ''
              {
                const first = extractTextAndFinish(rawText)
                out = first.text || ''
                finishReason = first.finishReason || ''
              }

              const needsContinue = (reason) =>
                /MAX_TOKENS|FINISH_REASON_MAX_TOKENS/i.test(String(reason || ''))

              for (let i = 0; i < maxContinues && needsContinue(finishReason); i++) {
                // 모델 응답을 대화에 붙인 후, 사용자가 "이어쓰기"를 요청한 것으로 다음 호출
                contents.push({ role: 'model', parts: [{ text: out.split('\n').slice(-40).join('\n') }] })
                contents.push({
                  role: 'user',
                  parts: [
                    {
                      text:
                        '방금 답변을 이어서 계속 작성해줘. 이미 말한 문장은 반복하지 말고, 끊긴 지점부터 이어서. 끝까지 완결해줘.',
                    },
                  ],
                })

                const r2 = await callGemini(usedModel || modelCandidates[0], contents)
                const raw2 = await r2.text()
                if (!r2.ok) break
                const next = extractTextAndFinish(raw2)
                const chunk = next.text || ''
                if (chunk) out = `${out}\n${chunk}`.trim()
                finishReason = next.finishReason || ''
              }

              // 고정밀 모드(비용 증가): 1회 자체 검토/보강(refine). 이미지 없음·JSON 작업에서는 생략.
              const refineEnabled =
                String(env.GEMINI_DISABLE_REFINE || '').trim() !== '1' &&
                String(env.GEMINI_DISABLE_REFINE || '').trim().toLowerCase() !== 'true'
              const isReportJsonJob = /최종 보고서|SWOT|종합 피드백/i.test(
                String(contextDescription || ''),
              )
              // refine은 답을 길게 키워 환각을 부추길 수 있음: JSON 산출물·이미지 없음·클라이언트 요청 시 생략
              const refineShouldRun =
                refineEnabled &&
                out &&
                out.trim() &&
                !isReportJsonJob &&
                skipRefineBody !== true &&
                hasImages
              if (refineShouldRun) {
                try {
                  const refinePrompt = `아래는 너의 '초안 답변'이다. 같은 질문/이미지 맥락을 유지하면서 최종 답변을 다시 작성해라.

중요:
- 초안이 '근거 부족', '추가 사진 필요', 짧은 확인 질문 위주라면: 길이를 늘리지 말고 문장만 명확하게 다듬어라. 새로운 단자번호·배선·측정값을 추가하지 마라.
- 이미지에서 보이지 않는 사실을 보강하지 마라.
- 근거가 충분할 때만 아래 형식을 유지하고, 부족하면 2~6문장으로 끝내도 된다.

가능하면 유지할 형식:
1) 결론 요약
2) 관찰/근거
3) 분석(원인 후보 우선순위)
4) 점검/조치 순서(체크리스트)
5) 추가 질문(필요 시)

초안 답변:
${out}`

                  contents.push({ role: 'model', parts: [{ text: out }] })
                  contents.push({ role: 'user', parts: [{ text: refinePrompt }] })
                  const rr = await callGemini(usedModel || modelCandidates[0], contents)
                  const rawR = await rr.text()
                  if (rr.ok) {
                    const refined = extractTextAndFinish(rawR).text || ''
                    if (refined.trim()) out = refined.trim()
                  }
                } catch {
                  // refine 실패 시 초안 유지
                }
              }

              res.setHeader('Content-Type', 'application/json; charset=utf-8')
              res.statusCode = 200
              // 프런트는 OpenAI 형태(choices[0].message.content)를 기대하므로, 호환 포맷으로 감쌉니다.
              res.end(JSON.stringify({ choices: [{ message: { content: out } }] }))
            } catch (e) {
              res.statusCode = 500
              res.setHeader('Content-Type', 'application/json; charset=utf-8')
              res.end(
                JSON.stringify({
                  error: { message: e instanceof Error ? e.message : String(e) },
                }),
              )
            }
          })
        },
      },
    ],
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'index.html'),
        },
      },
    },
  }
})

/**
 * @param {import('http').IncomingMessage} req
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
