/**
 * Gemini 채팅 프록시 공용 로직 (Vite dev 미들웨어 · Netlify Function에서 동일 사용)
 * @param {object} body
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<{ ok: true, body: string } | { ok: false, statusCode: number, body: string }>}
 */
export async function runGeminiChatProxy(body, env) {
  const { messages, contextDescription, images, skipRefine: skipRefineBody } = body || {}

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

  const primaryModel = normalizeModel(
    env.GEMINI_MODEL ||
      env.GOOGLE_MODEL ||
      (netlifyFast ? 'gemini-2.5-flash' : 'gemini-2.5-pro'),
  )
  const fallbackModels = String(
    env.GEMINI_FALLBACK_MODELS ||
      (netlifyFast
        ? 'gemini-2.5-flash,gemini-2.0-flash'
        : 'gemini-2.5-pro,gemini-2.5-flash,gemini-3-flash-preview'),
  )
    .split(',')
    .map((s) => normalizeModel(s))
    .filter(Boolean)
  let modelCandidates = Array.from(
    new Set([primaryModel, ...fallbackModels]),
  )
  if (netlifyFast) {
    const flashFirst = modelCandidates.filter((m) => /flash/i.test(m))
    const rest = modelCandidates.filter((m) => !/flash/i.test(m))
    modelCandidates = [...flashFirst, ...rest]
  }

  /** Netlify Functions: 실행 시간·업로드 한도 안에 끝나도록 가벼운 설정 */
  const tokensParsed = Number(String(env.GEMINI_MAX_OUTPUT_TOKENS || '').trim())
  const maxOutputTokens =
    Number.isFinite(tokensParsed) &&
    tokensParsed >= 512 &&
    tokensParsed <= 8192
      ? Math.floor(tokensParsed)
      : netlifyFast
        ? 4096
        : 6144
  const modelCandidatesRun = netlifyFast
    ? modelCandidates.slice(0, 2)
    : modelCandidates
  const maxContinues = netlifyFast ? 2 : 4
  const retryDelaysMs = netlifyFast ? [400] : [250, 750, 1500]

  const imageList = Array.isArray(images) ? images : []
  const hasImages = imageList.length > 0

  if (netlifyFast && imageList.length > 3) {
    return {
      ok: false,
      statusCode: 413,
      body: JSON.stringify({
        error: {
          message:
            '한 번에 보낼 이미지가 너무 많습니다. 회로도 1장과 실습 사진 1~2장만 포함해 다시 질문해 주세요.',
        },
      }),
    }
  }

  let approxImageBytes = 0
  for (const img of imageList) {
    const m = /^data:[^;]+;base64,(.+)$/i.exec(String(img?.dataUrl || ''))
    if (m) approxImageBytes += Math.ceil((m[1].length * 3) / 4)
  }
  const maxImageBytes = netlifyFast ? 3_500_000 : 8_000_000
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

${
    netlifyFast
      ? `\n배포 환경: 각 항목은 2~4문장으로 간결히 쓰되, 형식(1~5)을 반드시 끝까지 완결하세요. 중간에 문장을 끊지 마세요.`
      : ''
  }

현재 실습 단계 맥락: ${contextDescription || ''}`

  try {
    const contents = (Array.isArray(messages) ? messages : []).map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content ?? '') }],
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
              temperature: 0.25,
              topP: 0.9,
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
      if (!t || t.length < 150) return false
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
