/**
 * Gemini 채팅 프록시 공용 로직 (Vite dev · Vercel api/openai/chat)
 * @param {object} body
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<{ ok: true, body: string } | { ok: false, statusCode: number, body: string }>}
 */
export async function prepareGeminiChatRequest(body, env) {
  const {
    messages,
    contextDescription,
    images,
    skipRefine: skipRefineBody,
    practiceContext,
    chatGuidance,
    hasImages: hasImagesBody,
    preferFlash: preferFlashBody,
    aiTask: aiTaskBody,
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
            '서버에 GEMINI_API_KEY(또는 GOOGLE_API_KEY)가 설정되어 있지 않습니다. 로컬은 .env, Vercel은 Project → Environment Variables에 추가한 뒤 재배포하세요.',
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
  const isServerlessDeploy = String(env.VERCEL || '') === '1'
  const serverlessCompact =
    isServerlessDeploy &&
    String(env.GEMINI_SERVERLESS_COMPACT ?? '0').trim() === '1'

  const ctx = String(contextDescription || '')
  const aiTask = String(aiTaskBody || '').trim().toLowerCase()
  const isTeacherDraftJob =
    aiTask === 'teacher-draft' ||
    /교사용 개별 피드백 초안/i.test(ctx)
  const isReportJsonJob =
    aiTask === 'report-json' ||
    (/최종 보고서|SWOT|종합 피드백/i.test(ctx) && !isTeacherDraftJob)
  const isReportJob = isReportJsonJob || isTeacherDraftJob
  const isChatJob = !isReportJob

  const explicitModel = normalizeModel(
    env.GEMINI_MODEL || env.GOOGLE_MODEL || '',
  )
  const chatModelEnv = normalizeModel(env.GEMINI_CHAT_MODEL || '')

  const defaultModel = 'gemini-2.5-flash'
  const flashPrimary = 'gemini-2.5-flash'
  let primaryModel
  if (preferFlashBody === true) {
    primaryModel = flashPrimary
  } else if (isChatJob) {
    primaryModel = chatModelEnv || explicitModel || defaultModel
  } else if (isReportJob) {
    primaryModel = explicitModel || chatModelEnv || defaultModel
  } else {
    primaryModel = explicitModel || defaultModel
  }

  const useProPrimary = /pro/i.test(primaryModel)

  const proOnlyFlag = String(env.GEMINI_PRO_ONLY ?? '').trim().toLowerCase()
  const proOnly =
    proOnlyFlag === '1' ||
    proOnlyFlag === 'true' ||
    (proOnlyFlag !== '0' &&
      proOnlyFlag !== 'false' &&
      useProPrimary &&
      preferFlashBody !== true)

  const chatFallbackDefault = proOnly ? '' : 'gemini-2.5-flash,gemini-2.0-flash'

  const fallbackModels = String(
    env.GEMINI_FALLBACK_MODELS ?? chatFallbackDefault,
  )
    .split(',')
    .map((s) => normalizeModel(s))
    .filter(Boolean)
    .filter((m) => !proOnly || /pro/i.test(m))

  /** Background 작업(GEMINI_BG_JOB)은 동기 한도 없음 */
  const isBgJob = String(env.GEMINI_BG_JOB || '').trim() === '1'

  let modelCandidates = dedupeModels(
    proOnly ? [primaryModel] : [primaryModel, ...fallbackModels],
  )
  if (proOnly) {
    modelCandidates = modelCandidates.filter((m) => /pro/i.test(m))
    if (!modelCandidates.length) {
      modelCandidates = dedupeModels([
        chatModelEnv || explicitModel || 'gemini-2.5-pro',
      ]).filter((m) => /pro/i.test(m))
    }
  } else if (useProPrimary || isBgJob) {
    const proFirst = modelCandidates.filter((m) => /pro/i.test(m))
    const rest = modelCandidates.filter((m) => !/pro/i.test(m))
    modelCandidates = [...proFirst, ...rest]
  } else if ((isChatJob || isReportJob) && serverlessCompact) {
    const flashFirst = modelCandidates.filter((m) => /flash/i.test(m))
    const rest = modelCandidates.filter((m) => !/flash/i.test(m))
    modelCandidates = [...flashFirst, ...rest]
  }
  const syncProTight =
    isServerlessDeploy &&
    useProPrimary &&
    !isBgJob &&
    preferFlashBody !== true &&
    String(env.GEMINI_SYNC_PRO_TIGHT ?? '0').trim() === '1'

  const earlyMsgList = (Array.isArray(messages) ? messages : []).filter((m) => {
    const t = String(m?.content || '').trim()
    if (m?.role === 'user' && /^다음은 전기 실습/.test(t)) return false
    return true
  })
  const earlyLastQ = (() => {
    for (let i = earlyMsgList.length - 1; i >= 0; i--) {
      if (earlyMsgList[i]?.role === 'user') {
        const t = String(earlyMsgList[i].content || '').trim()
        if (t && !/^다음은 전기 실습/.test(t)) return t
      }
    }
    return ''
  })()
  const wantsDetail =
    isChatJob &&
    /종합|전체|접점|단자|번호|표|목록|EOCR|MC|PB|릴레이|회로도.*작성|기입|정리|작성해/i.test(
      `${earlyLastQ}\n${contextDescription}`,
    )

  const tokensParsed = Number(String(env.GEMINI_MAX_OUTPUT_TOKENS || '').trim())
  const defaultMaxTokens = isReportJsonJob
    ? useProPrimary
      ? 2048
      : 1792
    : isTeacherDraftJob
      ? useProPrimary
        ? 1536
        : 1280
      : useProPrimary
        ? syncProTight
          ? isChatJob
            ? wantsDetail
              ? 2048
              : 1536
            : 2048
          : isChatJob
            ? wantsDetail
              ? 2048
              : 1536
            : 2048
    : serverlessCompact
      ? 3584
      : 6144
  const maxOutputTokens =
    Number.isFinite(tokensParsed) &&
    tokensParsed >= 512 &&
    tokensParsed <= 8192
      ? Math.floor(tokensParsed)
      : defaultMaxTokens

  const modelCandidatesRun =
    proOnly
      ? modelCandidates.slice(0, 1)
      : serverlessCompact && !isBgJob
        ? modelCandidates.slice(0, useProPrimary ? 3 : 2)
        : modelCandidates

  const maxContinues =
    syncProTight && isChatJob
      ? 0
      : isReportJsonJob || isTeacherDraftJob
        ? isServerlessDeploy
          ? 2
          : 3
        : isBgJob && isChatJob
          ? 2
          : isChatJob
            ? isServerlessDeploy
              ? proOnly
                ? 1
                : 2
              : useProPrimary
                ? 2
                : 2
            : useProPrimary
            ? syncProTight
              ? 0
              : 3
            : serverlessCompact
              ? 2
              : 4
  const retryDelaysMs = isBgJob
    ? [700, 1500, 3000, 5000, 8000]
    : syncProTight
      ? [300, 700, 1200]
      : serverlessCompact
        ? [400, 900, 1800]
        : [250, 750, 1500, 3000]

  const fetchTimeoutParsed = Number(String(env.GEMINI_FETCH_TIMEOUT_MS || '').trim())
  const geminiFetchTimeoutMs =
    Number.isFinite(fetchTimeoutParsed) && fetchTimeoutParsed >= 5000
      ? Math.floor(fetchTimeoutParsed)
      : isServerlessDeploy
        ? syncProTight
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

  if (serverlessCompact && imageList.length > 4) {
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
  const maxImageBytes = syncProTight
    ? 2_400_000
    : serverlessCompact
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
    isReportJsonJob
      ? `【보고서 JSON 작업】
- 사용자 지시대로 **유효한 JSON만** 출력합니다(설명·마크다운·\`\`\` 없음).
- 키 summary, swot {s,w,o,t} 를 채웁니다.
- Circuit Chatbot 대화·첨부 이미지·자기평가·학습자 SWOT 초안을 **함께 읽고** 일관된 종합 피드백을 만듭니다. 대화를 무시한 일반론·동문서답 금지.
- 자료에 없는 단자·배선·고장 단정 금지.`
      : isTeacherDraftJob
        ? `【교사 피드백 초안】
- 제출 SWOT·자기평가·사진만 근거로 피드백 초안 작성.
- **짧은 개요형**: ## 총평(1~2문장) → ## 잘한 점(불릿 1~2) → ## 보완(불릿 1~2) → ## 안전(해당 시 1문장). **250~450자**.
- 제출에 없는 사실·단자 번호 금지.`
        : isChatJob
          ? wantsDetail
            ? `채팅(상세·목록·접점):
- 질문에 직접 답함. ## 요약(1줄) → ## 핵심(불릿 3~5, 끝까지 완결). **최대 500자**.
- 접점·단자는 도면 표기만.`
            : `채팅 답변(요약형):
- 마지막 질문에 **직접** 답함. 동문서답·강의 금지.
- 형식: ## 요약(1줄) → ## 핵심(불릿 2~3) → ## 할 일(불릿 1~2). 안전은 맨 위 ## 안전(1문장).
- **200~380자**. 짧고 명확하게.`
          : ''
  }

정확성(환각 방지):
- 확인한 사실만 씁니다. 불확실하면 "도면·실물 확인 필요" 한 줄.
- 접점·코일·단자 번호(A1-A2, 95-96, 6-12 등)는 **도면·사진에 보이는 표기만**. 안 보이면 추측·일반론 번호를 쓰지 마세요.
- EOCR·MC·T·PB는 기기·제조사마다 표기가 다릅니다. 다른 기기 번호를 섞어 쓰지 마세요.
- 추측·가상 배선 금지. 근거는 꼭 필요한 주장에만 (근거: …) 1회.
- 확인 질문은 최대 1개(정말 필요할 때만).

학습자 수준: 전기 초보자도 이해할 수 있게, 전문 용어는 괄호로 쉬운 뜻을 붙입니다.
안전: 감전·단락·과열 가능성이 있으면 맨 앞에 전원 차단·LOCKOUT을 안내합니다.

${
    isReportJsonJob
      ? hasImages
        ? `첨부 이미지·대화·자기평가를 교차 확인해 JSON의 summary·swot를 채우세요.`
        : `이미지 없음: 대화·자기평가·SWOT 초안만으로 JSON을 채우세요.`
      : isTeacherDraftJob
        ? hasImages
          ? `제출 회로도·결과 사진을 보고 피드백 초안에 반영하세요.`
          : `사진 없음: 텍스트 제출(SWOT·자기평가)만 근거로 초안을 작성하세요.`
        : hasImages && isChatJob
          ? `첨부 이미지(회로도·실습 사진)는 마지막 학생 질문에 답할 때 참고하세요.`
          : !hasImages && isChatJob
            ? `분석용 이미지 없음: 단자·배선 단정 금지. 필요한 사진 안내와 일반 안전만 개요형으로 답하세요.`
            : hasImages && !isChatJob
              ? `이번 요청에 회로도·실습 사진이 포함될 수 있습니다.`
              : `분석용 이미지가 없습니다. 추측 진단·단자 번호를 쓰지 마세요.`
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
    if (serverlessCompact && msgList.length > 12) {
      msgList = msgList.slice(-12)
    }

    const lastUserQuestion = getLastUserQuestion(msgList)

    const contents = msgList.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: trimText(m.content, serverlessCompact ? 2800 : 4800) }],
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
      const qBlock =
        isReportJsonJob || isTeacherDraftJob
          ? `【작업 지시】\n${lastUserQuestion || '(지시문 참고)'}`
          : lastUserQuestion
            ? `【이번 학생 질문 — 이것에만 답할 것】\n${lastUserQuestion}`
            : '【이번 학생 질문】 (텍스트 없음 — 이미지 기준으로 안내)'
      const lengthHint = isReportJsonJob
        ? 'JSON만. summary 2~4문장, swot 각 1문장. 대화·SWOT 반영.'
        : isTeacherDraftJob
          ? '교사 피드백 초안: ## 총평·잘한 점·보완, 250~450자.'
          : wantsDetail
            ? '## 요약 + 불릿 3~5개, 최대 500자. 끝까지 완결.'
            : '## 요약·핵심·할 일, 200~380자. 짧게 요약.'
      contents[lastUserIdx].parts.unshift({
        text: `${qBlock}\n\n【참고 이미지】${attachNote || '첨부됨'}\n${lengthHint}`,
      })

      for (const img of imageList) {
        const part = toInlinePart(img)
        if (part) contents[lastUserIdx].parts.push(part)
      }
    }

    return {
      ok: true,
      key,
      systemContent,
      contents,
      modelCandidatesRun,
      maxOutputTokens,
      isChatJob,
      geminiFetchTimeoutMs,
      temperature: isChatJob ? 0.12 : 0.12,
      topP: isChatJob ? 0.85 : 0.9,
      serverlessCompact,
      syncProTight,
      primaryModel,
      maxContinues,
      retryDelaysMs,
      skipRefineBody,
      hasImages,
      contextDescription,
      imageList,
      lastUserQuestion,
      wantsDetail,
      isReportJsonJob,
      isTeacherDraftJob,
      proOnly,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      statusCode: 500,
      body: JSON.stringify({
        error: {
          message: /abort|timeout|timed out/i.test(msg)
            ? '서버 응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.'
            : msg,
        },
      }),
    }
  }
}

/**
 * @param {object} body
 * @param {Record<string, string | undefined>} env
 */
export async function runGeminiChatProxy(body, env) {
  const prep = await prepareGeminiChatRequest(body, env)
  if (!prep.ok) {
    return { ok: false, statusCode: prep.statusCode, body: prep.body }
  }

  const {
    key,
    systemContent,
    contents,
    modelCandidatesRun,
    maxOutputTokens,
    isChatJob,
    geminiFetchTimeoutMs,
    serverlessCompact,
    syncProTight,
    primaryModel,
    maxContinues,
    retryDelaysMs,
    skipRefineBody,
    hasImages,
    contextDescription,
    imageList,
    lastUserQuestion,
  } = prep

  try {
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
              temperature: isChatJob ? 0.12 : 0.12,
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

    if (!out.trim() && imageList.length && isChatJob && !prep.proOnly) {
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

    for (
      let i = 0;
      i < maxContinues && needsContinueGeneration(finishReason, out, isChatJob);
      i++
    ) {
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

    if (looksTruncatedText(out, false) && !isChatJob) {
      out = `${out}\n\n(답변이 길어 여기서 끊겼을 수 있습니다. 채팅에 「이어서 작성해줘」라고 입력하면 나머지를 이어 받을 수 있습니다.)`
    }

    const refineOptOut =
      String(env.GEMINI_DISABLE_REFINE || '').trim() === '1' ||
      String(env.GEMINI_DISABLE_REFINE || '').trim().toLowerCase() === 'true'
    const refineEnabled =
      !refineOptOut &&
      (!serverlessCompact || String(env.GEMINI_ENABLE_REFINE || '').trim() === '1')
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

/** @param {string} text @param {boolean} [isChatJob] */
function looksTruncatedText(text, isChatJob = false) {
  const t = String(text || '').trim()
  if (!t) return false

  if (isChatJob) {
    const lines = t.split(/\n/).map((l) => l.trim()).filter(Boolean)
    const lastLine = lines.length ? lines[lines.length - 1] : t

    if (/[:：]\s*$/.test(lastLine) || /[:：]\s*$/.test(t)) return true

    if (
      /^[-*•●\d]|^\s*\d+[.)]/.test(lastLine) &&
      lastLine.length > 6 &&
      !/[.!?。…』」\)]\s*$/.test(lastLine)
    ) {
      return true
    }

    const endsMid =
      /[가-힣0-9a-zA-Z(,（·]\s*$/.test(t) &&
      !/[.!?。…』」\)]\s*$/.test(t)
    if (endsMid && t.length >= 25) return true
    if (
      /확인된\s*근거|②|근거\s*[:：]/.test(t) &&
      !/할\s*일|③|다음\s*할|지금\s*할|해야/i.test(t)
    ) {
      return true
    }
    return false
  }

  if (t.length < 120) return false
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

/** @param {string} [finishReason] @param {string} text @param {boolean} [isChatJob] */
function needsContinueGeneration(finishReason, text, isChatJob = false) {
  return (
    /MAX_TOKENS/i.test(String(finishReason || '')) ||
    looksTruncatedText(text, isChatJob)
  )
}

function stripInlineImagesFromContents(contentsArr) {
  return contentsArr.map((turn) => ({
    role: turn.role,
    parts: (turn.parts || []).filter((p) => !p.inlineData),
  }))
}

/** @param {object} prep @param {string} model @param {object[]} contents */
async function geminiGenerateOnce(prep, model, contents) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model,
    )}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': prep.key,
      },
      body: JSON.stringify({
        systemInstruction: {
          role: 'system',
          parts: [{ text: prep.systemContent }],
        },
        contents,
        generationConfig: {
          temperature: prep.temperature,
          topP: prep.topP,
          maxOutputTokens: prep.maxOutputTokens,
        },
      }),
      signal: AbortSignal.timeout(prep.geminiFetchTimeoutMs),
    },
  )
  const raw = await res.text()
  if (!res.ok) {
    let msg = raw
    try {
      msg = JSON.parse(raw).error?.message || raw
    } catch {
      /* ignore */
    }
    return { ok: false, status: res.status, message: String(msg || '') }
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return { ok: false, status: 502, message: 'invalid_json' }
  }
  const parts = data.candidates?.[0]?.content?.parts
  const text = Array.isArray(parts)
    ? parts
        .filter((p) => p && p.thought !== true)
        .map((p) => (typeof p?.text === 'string' ? p.text : ''))
        .join('')
        .trim()
    : ''
  const finishReason = String(data.candidates?.[0]?.finishReason || '').trim()
  if (!text) return { ok: false, status: 502, message: 'empty_response' }
  return { ok: true, text, finishReason }
}

/** @param {object} prep @param {string} model @param {string} text @param {(obj: object) => void} push */
async function continueStreamedAnswer(prep, model, text, push) {
  const maxRounds = Math.min(Math.max(prep.maxContinues || 0, 0), 3)
  let out = String(text || '').trim()
  let finishReason = ''

  for (let i = 0; i < maxRounds; i++) {
    if (!needsContinueGeneration(finishReason, out, prep.isChatJob)) break
    push({ event: 'status', message: '답변 마무리 중…' })
    const contents = [
      ...stripInlineImagesFromContents(prep.contents),
      { role: 'model', parts: [{ text: out.slice(-2500) }] },
      {
        role: 'user',
        parts: [
          {
            text: prep.isReportJsonJob
              ? 'JSON 출력이 끊겼습니다. 끊긴 위치부터 **유효한 JSON만** 이어 완성하세요. 이미 출력한 부분은 반복하지 마세요.'
              : prep.isTeacherDraftJob
                ? '교사 피드백 초안이 끊겼습니다. 끊긴 위치부터 마크다운 개요형(##·불릿)으로 이어 쓰세요. 반복하지 마세요.'
                : prep.isChatJob
                  ? prep.wantsDetail
                    ? '답변이 끊겼습니다. 끊긴 불릿·항목부터 끝까지 이어 쓰세요. 마크다운 개요형 유지. 반복하지 마세요.'
                    : '답변이 끊겼습니다. ## 근거·## 지금 할 일을 포함해 마크다운 개요형으로 이어 완결하세요. 반복하지 마세요.'
                  : '방금 답변을 이어서 계속 작성해줘. 끊긴 지점부터 이어서. 끝까지 완결해줘.',
          },
        ],
      },
    ]
    const hit = await geminiGenerateOnce(prep, model, contents)
    if (!hit.ok || !hit.text) break
    const chunk = String(hit.text).trim()
    if (chunk) {
      out = `${out}\n${chunk}`.trim()
      push({ event: 'chunk', text: chunk })
    }
    finishReason = hit.finishReason || ''
  }
  return out
}

/** @param {unknown} obj */
function extractStreamChunkText(obj) {
  const parts = obj?.candidates?.[0]?.content?.parts
  if (!Array.isArray(parts)) return ''
  return parts
    .filter((p) => p && p.thought !== true)
    .map((p) => (typeof p?.text === 'string' ? p.text : ''))
    .join('')
}

async function consumeGeminiSseStream(body, onText) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let full = ''
  let finishReason = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split(/\r?\n/)
    buf = lines.pop() || ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed === 'data: [DONE]') continue
      let jsonStr = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed
      if (!jsonStr || jsonStr === '[' || jsonStr === ']') continue
      try {
        const data = JSON.parse(jsonStr)
        const fr = String(data.candidates?.[0]?.finishReason || '').trim()
        if (fr) finishReason = fr
        const chunk = extractStreamChunkText(data)
        if (chunk) {
          full += chunk
          onText(chunk)
        }
      } catch {
        /* ignore partial */
      }
    }
  }

  const tail = buf.trim()
  if (tail && tail !== 'data: [DONE]') {
    try {
      let jsonStr = tail.startsWith('data:') ? tail.slice(5).trim() : tail
      const data = JSON.parse(jsonStr)
      const fr = String(data.candidates?.[0]?.finishReason || '').trim()
      if (fr) finishReason = fr
      const chunk = extractStreamChunkText(data)
      if (chunk) {
        full += chunk
        onText(chunk)
      }
    } catch {
      /* ignore */
    }
  }

  return { text: full.trim(), finishReason }
}

/** @param {object} prep @param {string} model @param {(obj: object) => void} push */
async function streamOneGeminiModel(prep, model, push) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:streamGenerateContent?alt=sse`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': prep.key,
    },
    body: JSON.stringify({
      systemInstruction: {
        role: 'system',
        parts: [{ text: prep.systemContent }],
      },
      contents: prep.contents,
      generationConfig: {
        temperature: prep.temperature,
        topP: prep.topP,
        maxOutputTokens: prep.maxOutputTokens,
      },
    }),
    signal: AbortSignal.timeout(prep.geminiFetchTimeoutMs),
  })

  if (!res.ok) {
    const raw = await res.text()
    let msg = raw
    try {
      msg = JSON.parse(raw).error?.message || raw
    } catch {
      /* ignore */
    }
    return { ok: false, status: res.status, message: String(msg || '') }
  }
  if (!res.body) return { ok: false, status: 502, message: 'empty_response' }

  const streamed = await consumeGeminiSseStream(res.body, (chunk) => {
    push({ event: 'chunk', text: chunk })
  })
  if (!streamed.text) return { ok: false, status: 502, message: 'empty_response' }

  let text = streamed.text
  if (needsContinueGeneration(streamed.finishReason, text, prep.isChatJob)) {
    text = await continueStreamedAnswer(prep, model, text, push)
  }

  return { ok: true, text, model }
}

/** @param {object} body @param {Record<string, string | undefined>} env @param {(obj: object) => void} push */
async function runGeminiChatBufferedFallback(body, env, push) {
  push({ event: 'status', message: 'Pro 모델로 분석 중…' })
  const pingMs = 900
  const pingTimer = setInterval(() => push({ event: 'ping' }), pingMs)
  try {
    const result = await runGeminiChatProxy({ ...body, stream: false }, env)
    clearInterval(pingTimer)
    if (!result.ok || result.statusCode !== 200) {
      let msg = '요청에 실패했습니다.'
      try {
        msg = JSON.parse(result.body).error?.message || msg
      } catch {
        /* ignore */
      }
      push({ event: 'error', message: msg })
      return
    }
    let text = ''
    let model = ''
    try {
      const j = JSON.parse(result.body)
      text = j.choices?.[0]?.message?.content || ''
      model = j.meta?.model || ''
    } catch {
      /* ignore */
    }
    if (!String(text).trim()) {
      push({ event: 'error', message: 'AI가 빈 답변을 반환했습니다.' })
      return
    }
    push({ event: 'done', text: String(text).trim(), model: model || undefined })
  } catch (e) {
    clearInterval(pingTimer)
    push({
      event: 'error',
      message: e instanceof Error ? e.message : String(e),
    })
  }
}

/** @param {object} body @param {Record<string, string | undefined>} env @param {(obj: object) => void} push */
export async function runGeminiChatStreamToPush(body, env, push) {
  const prep = await prepareGeminiChatRequest(body, env)
  if (!prep.ok) {
    let msg = '요청에 실패했습니다.'
    try {
      msg = JSON.parse(prep.body).error?.message || msg
    } catch {
      /* ignore */
    }
    push({ event: 'error', message: msg })
    return
  }

  const proMode = prep.modelCandidatesRun.some((m) => /pro/i.test(m))
  push({
    event: 'status',
    message: proMode ? 'Pro 모델로 분석 중…' : '회로·사진을 분석하는 중입니다…',
  })

  const pingTimer = setInterval(() => push({ event: 'ping' }), proMode ? 800 : 2000)
  let lastMsg = 'AI가 답변을 만들지 못했습니다.'

  try {
    for (const model of prep.modelCandidatesRun) {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) {
          push({ event: 'status', message: `다시 시도 중… (${attempt + 1}/2)` })
          await new Promise((r) => setTimeout(r, 2000))
        }
        try {
          const hit = await streamOneGeminiModel(prep, model, push)
          if (hit.ok && hit.text) {
            clearInterval(pingTimer)
            push({ event: 'done', text: hit.text, model: hit.model || model })
            return
          }
          lastMsg = hit.message || lastMsg
          const retryable =
            hit.status === 429 ||
            hit.status === 503 ||
            hit.status === 502 ||
            /overloaded|unavailable|empty_response/i.test(lastMsg)
          if (!retryable) break
        } catch (e) {
          lastMsg = e instanceof Error ? e.message : String(e)
          if (!/timeout|abort|503|429|overloaded/i.test(lastMsg)) break
        }
      }
    }
    clearInterval(pingTimer)
    await runGeminiChatBufferedFallback(body, env, push)
  } catch {
    clearInterval(pingTimer)
    await runGeminiChatBufferedFallback(body, env, push)
  }
}

/**
 * NDJSON 스트리밍 (Gemini SSE + ping, 실패 시 버퍼 폴백)
 */
export async function runGeminiChatWithHeartbeat(body, env, push) {
  await runGeminiChatStreamToPush(body, env, push)
}
