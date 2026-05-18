/**
 * Gemini 채팅 프록시 공용 로직 (Vite dev 미들웨어 · Netlify Function에서 동일 사용)
 * @param {object} body
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<{ ok: true, body: string } | { ok: false, statusCode: number, body: string }>}
 */
export async function runGeminiChatProxy(body, env) {
  const { messages, contextDescription, images, skipRefine: skipRefineBody } =
    body || {}

  const key = (
    env.GEMINI_API_KEY ||
    env.GOOGLE_API_KEY ||
    env.OPENAI_API_KEY ||
    ''
  ).trim()
  if (!key) {
    return {
      ok: false,
      statusCode: 500,
      body: JSON.stringify({
        error: {
          message:
            '서버에 GEMINI_API_KEY(또는 GOOGLE_API_KEY)가 설정되어 있지 않습니다. 로컬은 .env, Netlify는 Site settings → Environment variables에 추가한 뒤 다시 배포하세요.',
        },
      }),
    }
  }

  const normalizeModel = (m) => String(m || '').replace(/^models\//, '').trim()
  const isNetlify = String(env.NETLIFY || '').toLowerCase() === 'true'
  const netlifyFast =
    isNetlify && String(env.GEMINI_NETLIFY_FAST ?? '1').trim() !== '0'

  const ctx = String(contextDescription || '')
  const isReportJob =
    /최종 보고서|SWOT|종합 피드백|교사용 개별 피드백 초안/i.test(ctx)
  const isChatJob = !isReportJob

  const explicitModel = normalizeModel(
    env.GEMINI_MODEL || env.GOOGLE_MODEL || '',
  )
  const chatModelEnv = normalizeModel(env.GEMINI_CHAT_MODEL || '')

  let primaryModel =
    explicitModel ||
    (netlifyFast ? 'gemini-2.5-flash' : 'gemini-2.5-pro')

  // Netlify 실시간 채팅: pro는 10~26초 한도에 자주 걸림 → flash(정밀 프롬프트 유지)
  if (isNetlify && isChatJob) {
    primaryModel = chatModelEnv || 'gemini-2.5-flash'
  } else if (isNetlify && isReportJob) {
    primaryModel =
      explicitModel || chatModelEnv || 'gemini-2.5-pro'
  }

  const useProPrimary = /pro/i.test(primaryModel)

  const fallbackModels = String(
    env.GEMINI_FALLBACK_MODELS ||
      (useProPrimary
        ? 'gemini-2.5-flash'
        : netlifyFast
          ? 'gemini-2.5-flash,gemini-2.0-flash'
          : 'gemini-2.5-pro,gemini-2.5-flash,gemini-3-flash-preview'),
  )
    .split(',')
    .map((s) => normalizeModel(s))
    .filter(Boolean)

  let modelCandidates = Array.from(
    new Set([primaryModel, ...fallbackModels]),
  )
  // 환경 변수로 pro를 지정했으면 flash를 앞에 두지 않음 (정밀 모드 우선)
  if (netlifyFast && !useProPrimary) {
    const flashFirst = modelCandidates.filter((m) => /flash/i.test(m))
    const rest = modelCandidates.filter((m) => !/flash/i.test(m))
    modelCandidates = [...flashFirst, ...rest]
  }

  /** Netlify Functions: 실행 시간·업로드 한도. pro는 정밀 우선으로 토큰·이어쓰기 여유 */
  const tokensParsed = Number(String(env.GEMINI_MAX_OUTPUT_TOKENS || '').trim())
  const maxOutputTokens =
    Number.isFinite(tokensParsed) &&
    tokensParsed >= 512 &&
    tokensParsed <= 8192
      ? Math.floor(tokensParsed)
      : useProPrimary
        ? 4096
        : netlifyFast
          ? 3584
          : 6144
  const modelCandidatesRun = netlifyFast
    ? modelCandidates.slice(0, 2)
    : modelCandidates
  const maxContinues =
    isNetlify && isChatJob ? 1 : useProPrimary ? 3 : netlifyFast ? 2 : 4
  const retryDelaysMs = netlifyFast ? [400, 900] : [250, 750, 1500]

  const imageList = Array.isArray(images) ? images : []
  const hasImages = imageList.length > 0

  if (netlifyFast && imageList.length > 4) {
    return {
      ok: false,
      statusCode: 413,
      body: JSON.stringify({
        error: {
          message:
            '한 번에 보낼 이미지가 너무 많습니다. 회로도 1장과 실습 사진 2~3장 이하로 줄여 다시 질문해 주세요.',
        },
      }),
    }
  }

  let approxImageBytes = 0
  for (const img of imageList) {
    const m = /^data:[^;]+;base64,(.+)$/i.exec(String(img?.dataUrl || ''))
    if (m) approxImageBytes += Math.ceil((m[1].length * 3) / 4)
  }
  const maxImageBytes = netlifyFast ? 3_200_000 : 8_000_000
  if (approxImageBytes > maxImageBytes) {
    return {
      ok: false,
      statusCode: 413,
      body: JSON.stringify({
        error: {
          message:
            '이미지 용량이 커서 서버 한도를 넘었습니다. 회로도만 올린 뒤 다시 질문하거나, 사진 해상도를 낮춰 주세요.',
        },
      }),
    }
  }
  const systemContent = `당신은 전기 실습(회로·승강기·철도전기신호 등) 실습일지를 돕는 조교입니다. 항상 한국어로 답합니다.

목표: 학습자가 실습 중 질문하고, 회로도·실습 사진을 근거로 정확한 피드백을 받도록 돕습니다.

정확성(최우선 — 환각·오답 방지):
- 이미지·대화에서 직접 확인한 사실만 '확인됨'으로 씁니다. 읽기 어렵거나 안 보이면 "판독 불가" 또는 "확인 필요"라고만 씁니다.
- 단자 번호·배선 색·부품 모델·측정값·동작 상태를 추측으로 채우지 마세요. 근거 없는 문장은 쓰지 마세요.
- 각 항목에서 핵심 주장 뒤에 (근거: ○○ 이미지/표기에서 확인) 형태로 출처를 짧게 붙이세요.
- 회로도와 실습 사진이 함께 있으면 반드시 대조합니다. 불일치는 "도면 대비 ○○"처럼 구체적으로 적습니다.
- 확실하지 않으면 결론을 단정하지 말고 확인 질문 1~3개를 제시합니다.

학습자 수준:
- 전기 초보자도 이해할 수 있게, 전문 용어는 처음에 괄호로 쉬운 뜻을 붙입니다.
- 비난하지 않고, 실습에서 바로 할 수 있는 순서로 안내합니다.

분량:
- 불필요하게 길게 쓰지 않습니다. 각 번호 항목은 2~4문장(또는 짧은 목록)으로 씁니다.
- 다만 1)~5) 형식은 빠짐없이 끝까지 완결합니다. 중간에 문장을 끊지 마세요.

안전: 감전·단락·과열 가능성이 있으면 맨 앞에 전원 차단·LOCKOUT을 안내합니다.

${
    hasImages
      ? `이번 요청에 회로도·실습 사진이 포함될 수 있습니다. 라벨·단자·기호·배선을 읽어 정밀히 분석하세요.

답변 형식(반드시 1~5 모두 작성):
1) 결론 요약 — 무엇을 하는 회로/실습인지, 지금 상태 한줄 평가
2) 관찰/근거 — 이미지에서 확인한 표기·배선·부품만 (도면 vs 실물 대조 포함)
3) 분석 — 원인·불일치 후보는 근거가 있을 때만, 우선순위
4) 점검/조치 — 번호 목록(안전 순서), 학생이 지금 할 일
5) 추가 확인 — 부족한 정보·추가 촬영이 필요하면 1~3개만`
      : `분석용 이미지가 없습니다. 일반 안전·실습 원칙과, 구체 피드백을 위해 필요한 회로도/사진(촬영 방법 1문장씩)만 2~6문장으로 안내하세요. 가상의 회로 진단을 쓰지 마세요.`
  }

현재 실습 단계 맥락: ${contextDescription || ''}`

  try {
    const trimText = (s, max = 2400) => {
      const t = String(s ?? '')
      return t.length <= max ? t : `${t.slice(0, max)}\n…(이하 생략)`
    }

    let msgList = Array.isArray(messages) ? messages : []
    if (netlifyFast && msgList.length > 12) {
      msgList = msgList.slice(-12)
    }

    const contents = msgList.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: trimText(m.content, netlifyFast ? 2800 : 4800) }],
    }))

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
    const backoffMs = retryDelaysMs

    let lastStatus = 500
    let lastMessage = '요청에 실패했습니다.'
    let rawText = ''
    let usedModel = ''

    const stripInlineImagesFromContents = (contentsArr) =>
      contentsArr.map((turn) => ({
        role: turn.role,
        parts: (turn.parts || []).filter((p) => !p.inlineData),
      }))

    const extractTextAndFinish = (raw) => {
      let data
      try {
        data = JSON.parse(raw)
      } catch {
        return { text: '', finishReason: '', blocked: false }
      }
      const blockReason = String(
        data.promptFeedback?.blockReason ||
          data.candidates?.[0]?.finishMessage ||
          '',
      ).trim()
      const parts = data.candidates?.[0]?.content?.parts
      const text = Array.isArray(parts)
        ? parts
            .map((p) => (typeof p?.text === 'string' ? p.text : ''))
            .join('')
            .trim()
        : ''
      const finishReason = String(data.candidates?.[0]?.finishReason || '').trim()
      const blocked =
        !!blockReason ||
        finishReason === 'SAFETY' ||
        finishReason === 'RECITATION' ||
        (!text && !data.candidates?.length)
      return { text, finishReason, blocked, blockReason }
    }

    const blockedMessage = (blockReason, finishReason) => {
      if (/SAFETY|RECITATION|BLOCK/i.test(`${blockReason} ${finishReason}`)) {
        return '안전·정책 필터로 이 답변을 생성할 수 없습니다. 질문을 다르게 표현하거나, 회로도만 첨부해 다시 시도해 주세요.'
      }
      return '모델이 답변을 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.'
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
              temperature: 0.12,
              topP: 0.88,
              maxOutputTokens,
            },
          }),
        },
      )
      return r
    }

    for (const model of modelCandidatesRun) {
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
        if (
          /<TITLE>\s*Inactivity Timeout\s*<\/TITLE>/i.test(lastMessage) ||
          /Inactivity Timeout/i.test(lastMessage)
        ) {
          lastMessage =
            '서버 응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요. (이미지가 많거나 크면 한 장만 올린 뒤 질문해 보세요.)'
          break
        }

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

        break
      }

      if (lastStatus === 200) break
    }

    if (lastStatus !== 200) {
      const friendly =
        /high demand|overloaded|try again later|RESOURCE_EXHAUSTED/i.test(
          lastMessage,
        )
          ? '현재 Gemini 모델이 과부하 상태입니다(일시적). 잠시 후 다시 시도하거나, 다른 모델로 바꿔보세요.\n\n해결: 환경 변수에 GEMINI_MODEL=gemini-2.5-flash (또는 gemini-3-flash-preview) 를 넣거나, GEMINI_FALLBACK_MODELS에 여러 모델을 콤마로 지정할 수 있습니다.'
          : lastMessage
      return {
        ok: false,
        statusCode: lastStatus,
        body: JSON.stringify({ error: { message: friendly } }),
      }
    }

    let out = ''
    let finishReason = ''
    {
      const first = extractTextAndFinish(rawText)
      if (first.blocked && !first.text) {
        return {
          ok: false,
          statusCode: 422,
          body: JSON.stringify({
            error: {
              message: blockedMessage(first.blockReason, first.finishReason),
            },
          }),
        }
      }
      out = first.text || ''
      finishReason = first.finishReason || ''
    }

    if (!out.trim()) {
      return {
        ok: false,
        statusCode: 502,
        body: JSON.stringify({
          error: {
            message:
              'AI가 빈 응답을 반환했습니다. 잠시 후 다시 시도하거나, 회로도 1장만 올린 뒤 질문해 주세요.',
          },
        }),
      }
    }

    const looksTruncated = (text) => {
      const t = String(text || '').trim()
      if (!t || t.length < 120) return false
      if (/1\)\s*결론\s*요약/i.test(t) && !/5\)\s*추가/i.test(t)) return true
      if (
        t.length > 280 &&
        !/[.!?。…』」\)]\s*$/.test(t) &&
        /[가-힣0-9a-zA-Z(,（]\s*$/.test(t)
      ) {
        return true
      }
      return false
    }

    const needsContinue = (reason, text) =>
      /MAX_TOKENS/i.test(String(reason || '')) || looksTruncated(text)

    for (let i = 0; i < maxContinues && needsContinue(finishReason, out); i++) {
      contents.push({
        role: 'model',
        parts: [{ text: out.split('\n').slice(-40).join('\n') }],
      })
      contents.push({
        role: 'user',
        parts: [
          {
            text:
              '방금 답변을 이어서 계속 작성해줘. 이미 말한 문장은 반복하지 말고, 끊긴 지점부터 이어서. 끝까지 완결해줘.',
          },
        ],
      })

      const r2 = await callGemini(
        usedModel || modelCandidatesRun[0],
        stripInlineImagesFromContents(contents),
      )
      const raw2 = await r2.text()
      if (!r2.ok) break
      const next = extractTextAndFinish(raw2)
      const chunk = next.text || ''
      if (chunk) out = `${out}\n${chunk}`.trim()
      finishReason = next.finishReason || ''
    }

    if (looksTruncated(out)) {
      out = `${out}\n\n(답변이 길어 여기서 끊겼을 수 있습니다. 채팅에 「이어서 작성해줘」라고 입력하면 나머지를 이어 받을 수 있습니다.)`
    }

    const refineOptOut =
      String(env.GEMINI_DISABLE_REFINE || '').trim() === '1' ||
      String(env.GEMINI_DISABLE_REFINE || '').trim().toLowerCase() === 'true'
    const refineEnabled =
      !refineOptOut &&
      (!netlifyFast || String(env.GEMINI_ENABLE_REFINE || '').trim() === '1')
    const isReportJsonJob = /최종 보고서|SWOT|종합 피드백/i.test(
      String(contextDescription || ''),
    )
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
        const rr = await callGemini(usedModel || modelCandidatesRun[0], contents)
        const rawR = await rr.text()
        if (rr.ok) {
          const refined = extractTextAndFinish(rawR).text || ''
          if (refined.trim()) out = refined.trim()
        }
      } catch {
        /* refine 실패 시 초안 유지 */
      }
    }

    if (!out.trim()) {
      return {
        ok: false,
        statusCode: 502,
        body: JSON.stringify({
          error: {
            message:
              'AI가 빈 응답을 반환했습니다. 잠시 후 다시 시도해 주세요.',
          },
        }),
      }
    }

    return {
      ok: true,
      statusCode: 200,
      body: JSON.stringify({ choices: [{ message: { content: out } }] }),
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const friendly = /abort|timeout|timed out|ETIMEDOUT|ECONNRESET/i.test(msg)
      ? '서버 응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.'
      : msg
    return {
      ok: false,
      statusCode: 500,
      body: JSON.stringify({
        error: { message: friendly },
      }),
    }
  }
}

/**
 * NDJSON heartbeat — Netlify 게이트웨이 Inactivity Timeout 방지
 * @param {object} body
 * @param {Record<string, string | undefined>} env
 * @param {(obj: object) => void} push
 */
export async function runGeminiChatWithHeartbeat(body, env, push) {
  push({ event: 'status', message: '회로·사진을 분석하는 중입니다…' })
  let pingTimer = setInterval(() => push({ event: 'ping' }), 2500)
  try {
    const result = await runGeminiChatProxy(body, env)
    clearInterval(pingTimer)
    pingTimer = null

    if (result.statusCode !== 200) {
      let msg = '요청에 실패했습니다.'
      try {
        const j = JSON.parse(result.body)
        msg = j.error?.message || msg
      } catch {
        /* ignore */
      }
      push({ event: 'error', message: msg })
      return
    }

    let text = ''
    try {
      text = JSON.parse(result.body).choices?.[0]?.message?.content || ''
    } catch {
      /* ignore */
    }
    if (!String(text).trim()) {
      push({ event: 'error', message: '모델 응답이 비어 있습니다.' })
      return
    }
    push({ event: 'done', text: String(text).trim() })
  } catch (e) {
    if (pingTimer) clearInterval(pingTimer)
    push({
      event: 'error',
      message: e instanceof Error ? e.message : String(e),
    })
  }
}
