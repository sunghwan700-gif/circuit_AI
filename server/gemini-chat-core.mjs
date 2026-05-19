/**
 * Gemini 채팅 프록시 공용 로직 (Vite dev 미들웨어 · Netlify Function에서 동일 사용)
 * @param {object} body
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<{ ok: true, body: string } | { ok: false, statusCode: number, body: string }>}
 */
export async function runGeminiChatProxy(body, env) {
  const {
    messages,
    contextDescription,
    images,
    skipRefine: skipRefineBody,
    practiceContext,
    chatGuidance,
    hasImages: hasImagesBody,
  } = body || {}

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

  /** 신규 API 키·계정에서 막힌 모델 (폴백 목록에서 제외) */
  const isRetiredModel = (name) => {
    const n = normalizeModel(name).toLowerCase()
    if (!n) return true
    if (/flash-lite|gemini-1\.0|gemini-pro(?!-)/i.test(n)) return true
    if (
      n === 'gemini-2.0-flash-lite' ||
      n === 'gemini-1.5-flash-8b' ||
      n === 'gemini-1.5-flash-8b-latest'
    ) {
      return true
    }
    return false
  }

  const dedupeModels = (list) => {
    const out = []
    const seen = new Set()
    for (const raw of list) {
      const m = normalizeModel(raw)
      if (!m || isRetiredModel(m) || seen.has(m)) continue
      seen.add(m)
      out.push(m)
    }
    return out.length ? out : [defaultModel]
  }
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

  const defaultModel = 'gemini-2.5-flash'
  let primaryModel
  if (isChatJob) {
    primaryModel = chatModelEnv || explicitModel || defaultModel
  } else if (isReportJob) {
    primaryModel = explicitModel || chatModelEnv || defaultModel
  } else {
    primaryModel = explicitModel || defaultModel
  }

  const useProPrimary = /pro/i.test(primaryModel)

  const chatFallbackDefault = 'gemini-2.5-flash,gemini-2.0-flash'

  const fallbackModels = String(
    env.GEMINI_FALLBACK_MODELS || chatFallbackDefault,
  )
    .split(',')
    .map((s) => normalizeModel(s))
    .filter(Boolean)

  let modelCandidates = dedupeModels([primaryModel, ...fallbackModels])
  if (useProPrimary) {
    const proFirst = modelCandidates.filter((m) => /pro/i.test(m))
    const rest = modelCandidates.filter((m) => !/pro/i.test(m))
    modelCandidates = [...proFirst, ...rest]
  } else if (isChatJob || isReportJob || netlifyFast) {
    const flashFirst = modelCandidates.filter((m) => /flash/i.test(m))
    const rest = modelCandidates.filter((m) => !/flash/i.test(m))
    modelCandidates = [...flashFirst, ...rest]
  }

  /** Netlify + Pro: 26초 Function 한도 안에서 끝내기 위한 안전 모드 */
  const netlifyProSafe = isNetlify && useProPrimary

  const tokensParsed = Number(String(env.GEMINI_MAX_OUTPUT_TOKENS || '').trim())
  const defaultMaxTokens = useProPrimary
    ? netlifyProSafe
      ? isChatJob
        ? 2048
        : 2560
      : isChatJob
        ? 2048
        : 4096
    : netlifyFast
      ? 3584
      : 6144
  const maxOutputTokens =
    Number.isFinite(tokensParsed) &&
    tokensParsed >= 512 &&
    tokensParsed <= 8192
      ? Math.floor(tokensParsed)
      : defaultMaxTokens

  const modelCandidatesRun = netlifyFast
    ? modelCandidates.slice(0, useProPrimary ? 3 : 2)
    : modelCandidates

  const maxContinues =
    netlifyProSafe && isChatJob
      ? 0
      : isNetlify && isChatJob
        ? 1
        : useProPrimary
          ? netlifyProSafe
            ? 0
            : 3
          : netlifyFast
            ? 2
            : 4
  const retryDelaysMs = netlifyProSafe
    ? [300, 700]
    : netlifyFast
      ? [400, 900]
      : [250, 750, 1500]

  const fetchTimeoutParsed = Number(String(env.GEMINI_FETCH_TIMEOUT_MS || '').trim())
  const geminiFetchTimeoutMs =
    Number.isFinite(fetchTimeoutParsed) && fetchTimeoutParsed >= 5000
      ? Math.floor(fetchTimeoutParsed)
      : isNetlify
        ? netlifyProSafe
          ? 23_000
          : 24_000
        : 120_000

  const imageList = Array.isArray(images) ? images : []
  const hasImages =
    imageList.length > 0 || hasImagesBody === true || hasImagesBody === 'true'

  const getLastUserQuestion = (list) => {
    const arr = Array.isArray(list) ? list : []
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i]?.role === 'user') {
        const t = String(arr[i].content || '').trim()
        if (t && !/^다음은 전기 실습/.test(t)) return t
      }
    }
    return ''
  }

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
  const maxImageBytes = netlifyProSafe
    ? 2_400_000
    : netlifyFast
      ? 3_200_000
      : 8_000_000
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
  const chatExtra = isChatJob
    ? String(chatGuidance || '').trim()
    : ''
  const practiceExtra = String(practiceContext || '').trim()

  const systemContent = `당신은 전기 실습(회로·승강기·철도전기신호 등) 실습일지를 돕는 조교입니다. 항상 한국어로 답합니다.

목표: 학습자가 실습 중 질문하고, 회로도·실습 사진을 근거로 정확한 피드백을 받도록 돕습니다.

${
    isChatJob
      ? `채팅 답변 규칙(필수 — 알짜배기):
- 마지막 학생 질문에만 답합니다. 이전 답·질문과 무관한 회로 전체 설명은 쓰지 않습니다.
- 분량: 보통 전체 150~350자(한국어). 최대 500자. 불릿 3~5개 이내. 문단 2~3개 이내.
- 구조(이 순서만): ① 한 줄 핵심 결론 ② 확인된 근거 1~2개 (근거: …) ③ 지금 할 일 1~2가지. 안전 이슈 있으면 맨 위 1문장만.
- 장황한 서두·배경 설명·용어 사전·중복 문장 금지. 같은 뜻 반복 금지.
- 「종합 분석」「전체 점검」「처음부터」를 명시한 경우에만 불릿 6~8개까지 허용.
- 1)~5) 번호 형식은 학생이 종합 분석을 요청할 때만 사용.`
      : ''
  }

정확성(환각 방지 — 짧게):
- 확인한 사실만 씁니다. 불확실하면 "확인 필요" 한 줄.
- 추측·가상 단자번호·배선 금지. 근거는 꼭 필요한 주장에만 (근거: …) 1회.
- 확인 질문은 최대 1개(정말 필요할 때만).

학습자 수준: 전기 초보자도 이해할 수 있게, 전문 용어는 괄호로 쉬운 뜻을 붙입니다.
안전: 감전·단락·과열 가능성이 있으면 맨 앞에 전원 차단·LOCKOUT을 안내합니다.

${
    hasImages && !isChatJob
      ? `이번 요청에 회로도·실습 사진이 포함될 수 있습니다.

답변 형식(종합 분석 시 1~5 모두 작성):
1) 결론 요약
2) 관찰/근거 (도면 vs 실물 대조)
3) 분석
4) 점검/조치
5) 추가 확인`
      : hasImages && isChatJob
        ? `첨부 이미지(회로도·실습 사진)는 마지막 학생 질문에 답할 때만 참고하세요.`
        : `분석용 이미지가 없습니다. 가상의 회로 진단·단자 번호 추측을 쓰지 마세요. 일반 안전·필요한 사진 안내만 2~6문장으로 답하세요.`
  }

현재 실습 단계: ${contextDescription || ''}
${chatExtra ? `\n${chatExtra}` : ''}
${practiceExtra ? `\n${practiceExtra}` : ''}`

  try {
    const trimText = (s, max = 2400) => {
      const t = String(s ?? '')
      return t.length <= max ? t : `${t.slice(0, max)}\n…(이하 생략)`
    }

    let msgList = Array.isArray(messages) ? messages : []
    msgList = msgList.filter((m) => {
      const t = String(m?.content || '').trim()
      if (m?.role === 'user' && /^다음은 전기 실습/.test(t)) return false
      return true
    })
    if (netlifyFast && msgList.length > 12) {
      msgList = msgList.slice(-12)
    }

    const lastUserQuestion = getLastUserQuestion(msgList)

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
        .map((img) => String(img?.label || ''))
        .filter(Boolean)
        .join(', ')
      const qBlock = lastUserQuestion
        ? `【이번 학생 질문 — 이것에만 답할 것】\n${lastUserQuestion}`
        : '【이번 학생 질문】 (텍스트 없음 — 이미지 기준으로 짧게 안내)'
      contents[lastUserIdx].parts.unshift({
        text: `${qBlock}\n\n【참고 이미지】${attachNote || '첨부됨'}\n질문에 필요한 부분만 짧게 답하세요(150~350자, 불릿 3~5개). 전체 회로 강의·장문 설명 금지.`,
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
    let out = ''
    let finishReason = ''

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
            .filter((p) => p && p.thought !== true)
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
      /** @type {RequestInit} */
      const fetchInit = {
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
              temperature: isChatJob ? 0.18 : 0.12,
              topP: isChatJob ? 0.85 : 0.9,
              maxOutputTokens,
            },
        }),
        signal: AbortSignal.timeout(geminiFetchTimeoutMs),
      }
      return fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
          model,
        )}:generateContent`,
        fetchInit,
      )
    }

    const tryParseResponse = (raw, modelName) => {
      const parsed = extractTextAndFinish(raw)
      if (parsed.blocked && !parsed.text) {
        return {
          ok: false,
          blocked: true,
          message: blockedMessage(parsed.blockReason, parsed.finishReason),
        }
      }
      if (parsed.text.trim()) {
        return {
          ok: true,
          text: parsed.text,
          finishReason: parsed.finishReason,
          model: modelName,
        }
      }
      return { ok: false, blocked: false, empty: true }
    }

    modelLoop: for (const model of modelCandidatesRun) {
      for (let attempt = 0; attempt < backoffMs.length + 1; attempt++) {
        const r = await callGemini(model, contents)
        rawText = await r.text()

        if (r.ok) {
          const hit = tryParseResponse(rawText, model)
          if (hit.ok && hit.text) {
            out = hit.text
            finishReason = hit.finishReason || ''
            usedModel = hit.model || model
            lastStatus = 200
            break modelLoop
          }
          if (hit.blocked) {
            return {
              ok: false,
              statusCode: 422,
              body: JSON.stringify({ error: { message: hit.message } }),
            }
          }
          lastStatus = 502
          lastMessage = 'empty_response'
          if (attempt < backoffMs.length) {
            await sleep(backoffMs[attempt])
            continue
          }
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

        const modelUnavailable =
          lastStatus === 404 ||
          /no longer available|not found|is not supported|invalid model|NOT_FOUND/i.test(
            lastMessage,
          )

        if (modelUnavailable) {
          break
        }

        const shouldRetry =
          lastStatus === 429 ||
          lastStatus === 503 ||
          lastStatus === 500 ||
          /high demand|overloaded|try again later|RESOURCE_EXHAUSTED|UNAVAILABLE|capacity|quota/i.test(
            lastMessage,
          )

        if (shouldRetry && attempt < backoffMs.length) {
          await sleep(backoffMs[attempt])
          continue
        }

        break
      }
    }

    if (!out.trim() && imageList.length && isChatJob) {
      const textContents = stripInlineImagesFromContents(contents)
      const lastIdx = textContents.length - 1
      if (lastIdx >= 0 && textContents[lastIdx]?.role === 'user') {
        textContents[lastIdx].parts = [
          ...(textContents[lastIdx].parts || []).filter((p) => !p.inlineData),
          {
            text: '\n(이미지 분석이 비어 다시 시도합니다. 질문에 맞게 짧게 답하세요.)',
          },
        ]
      }
      const flashFallback = dedupeModels([
        'gemini-2.5-flash',
        ...modelCandidatesRun,
      ]).filter((m) => !/pro/i.test(m))
      for (const model of flashFallback.slice(0, 2)) {
        const r = await callGemini(model, textContents)
        rawText = await r.text()
        if (!r.ok) continue
        const hit = tryParseResponse(rawText, model)
        if (hit.ok && hit.text) {
          out = hit.text
          finishReason = hit.finishReason || ''
          usedModel = hit.model || model
          lastStatus = 200
          break
        }
        if (hit.blocked) {
          return {
            ok: false,
            statusCode: 422,
            body: JSON.stringify({ error: { message: hit.message } }),
          }
        }
      }
    }

    if (lastStatus !== 200) {
      const overloaded =
        lastStatus === 429 ||
        lastStatus === 503 ||
        /high demand|overloaded|try again later|RESOURCE_EXHAUSTED|UNAVAILABLE/i.test(
          lastMessage,
        )
      const modelGone = /no longer available|invalid model|not found/i.test(
        lastMessage,
      )
      const friendly = overloaded
        ? 'AI 서버가 잠시 바쁩니다. 10~20초 뒤에 같은 질문을 다시 보내 주세요. (사진이 많으면 회로도 1장만 첨부해 보세요.)'
        : modelGone
          ? 'AI 모델 연결에 문제가 있습니다. 잠시 후 다시 시도해 주세요.'
          : lastMessage
      return {
        ok: false,
        statusCode: lastStatus,
        body: JSON.stringify({ error: { message: friendly } }),
      }
    }

    if (!out.trim()) {
      return {
        ok: false,
        statusCode: 502,
        body: JSON.stringify({
          error: {
            message:
              'AI가 답변을 만들지 못했습니다. 10초 뒤 같은 질문을 다시 보내 주세요. (사진이 많으면 회로도 1장만 첨부해 보세요.)',
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

    if (looksTruncated(out) && !isChatJob) {
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
      !isChatJob &&
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
      body: JSON.stringify({
        choices: [{ message: { content: out } }],
        meta: { model: usedModel || primaryModel },
      }),
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
  const norm = (m) => String(m || '').replace(/^models\//, '').trim()
  const chatModel = norm(env.GEMINI_CHAT_MODEL || env.GEMINI_MODEL || '')
  const proMode = /pro/i.test(chatModel)
  push({
    event: 'status',
    message: proMode
      ? 'Pro 모델로 분석 중입니다. 정밀 분석에 30~60초 걸릴 수 있습니다…'
      : '회로·사진을 분석하는 중입니다…',
  })
  const pingMs = proMode ? 900 : 2500
  let pingTimer = setInterval(() => push({ event: 'ping' }), pingMs)
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
    let modelUsed = ''
    try {
      modelUsed = JSON.parse(result.body).meta?.model || ''
    } catch {
      /* ignore */
    }
    push({
      event: 'done',
      text: String(text).trim(),
      model: modelUsed ? String(modelUsed) : undefined,
    })
  } catch (e) {
    if (pingTimer) clearInterval(pingTimer)
    push({
      event: 'error',
      message: e instanceof Error ? e.message : String(e),
    })
  }
}
