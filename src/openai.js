/**
 * AI 채팅 — Vercel·로컬 공통 NDJSON 스트리밍 (Gemini 2.5 Pro)
 */
export function isOpenAiProxyAvailable() {
  return true
}

function getChatApiUrl() {
  return '/api/openai/chat'
}

function isProductionDeploy() {
  return (
    import.meta.env.VITE_VERCEL_DEPLOY === 'true' ||
    import.meta.env.PROD === true
  )
}

/** @deprecated 백그라운드 폴링 비사용 — 스트리밍만 사용 */
export function useAiChatBackground() {
  return false
}

/** @param {unknown} err */
export function normalizeChatFetchError(err) {
  const msg = err instanceof Error ? err.message : String(err || '')
  if (/failed to fetch|networkerror|load failed|aborterror/i.test(msg)) {
    return '서버에 연결하지 못했습니다. 새로고침 후 다시 시도해 주세요.'
  }
  if (/abort|timeout|timed out/i.test(msg)) {
    return '연결이 끊겼습니다. 같은 질문을 한 번 더 보내 주세요.'
  }
  return msg
}

function parseApiError(raw, status) {
  const text = String(raw || '').trim()
  if (!text) return `요청 실패 (${status})`

  try {
    const j = JSON.parse(text)
    const detail = j.error?.message || j.error
    if (typeof detail === 'string' && detail.trim()) return detail.trim()
  } catch {
    /* ignore */
  }

  if (
    /Inactivity Timeout|timed?\s*out|deadline exceeded|execution timed out|FUNCTION_INVOCATION_TIMEOUT/i.test(
      text,
    )
  ) {
    return '분석 시간이 초과되었습니다. 회로도 1장만 올리고 짧게 질문해 주세요.'
  }

  if (status === 504 || status === 502 || status === 503) {
    return 'AI 서버가 일시적으로 바쁩니다. 10~20초 뒤 같은 질문을 다시 보내 주세요.'
  }

  if (
    /deployment|FUNCTION_INVOCATION|An error occurred with your deployment|Cannot find module/i.test(
      text,
    )
  ) {
    return 'AI 서버가 응답하지 못했습니다. Vercel에 GEMINI_API_KEY가 설정됐는지 확인하고 재배포해 주세요.'
  }

  if (text.length > 280) {
    return `요청 실패 (${status}). 잠시 후 다시 시도해 주세요.`
  }
  return text
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function isTransientChatError(err) {
  const msg = (
    err instanceof Error ? err.message : String(err || '')
  ).toLowerCase()
  return (
    /바쁘|일시적|overloaded|unavailable|resource_exhausted|high demand|try again|503|502|504|429|timeout|timed out|빈 응답|empty|연결이 끊|분석 시간|실패했습니다/.test(
      msg,
    ) && !/quota|billing|api key|키가 설정|invalid.*key/i.test(msg)
  )
}

async function withAutoRetry(task, options, maxAttempts = 3) {
  let lastErr
  for (let i = 0; i < maxAttempts; i++) {
    try {
      if (i > 0) {
        options?.onStatus?.(
          `잠시 기다린 뒤 다시 시도합니다… (${i + 1}/${maxAttempts})`,
        )
        await sleep(5000 * i)
      }
      return await task()
    } catch (e) {
      lastErr = e
      if (!isTransientChatError(e) || i >= maxAttempts - 1) throw e
    }
  }
  throw lastErr
}

async function consumeNdjsonStream(body, handlers) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let resultText = ''
  let resultModel = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      const t = line.trim()
      if (!t) continue
      try {
        const ev = JSON.parse(t)
        if (ev.event === 'status' && ev.message) {
          handlers.onStatus?.(String(ev.message))
        }
        if (ev.event === 'chunk' && ev.text) {
          resultText += String(ev.text)
          handlers.onChunk?.(String(ev.text), resultText)
        }
        if (ev.event === 'error' && ev.message) {
          throw new Error(String(ev.message))
        }
        if (ev.event === 'done') {
          if (ev.text) resultText = String(ev.text)
          if (ev.model) resultModel = String(ev.model)
        }
      } catch (e) {
        if (e instanceof Error && e.message && !/JSON/i.test(e.message)) {
          throw e
        }
      }
    }
  }

  const tail = buf.trim()
  if (tail) {
    try {
      const ev = JSON.parse(tail)
      if (ev.event === 'done') {
        if (ev.text) resultText = String(ev.text)
        if (ev.model) resultModel = String(ev.model)
      }
      if (ev.event === 'error' && ev.message) {
        throw new Error(String(ev.message))
      }
    } catch (e) {
      if (e instanceof Error && !/JSON/i.test(e.message)) throw e
    }
  }

  return { text: resultText.trim(), model: resultModel.trim() }
}

async function sendOpenAiChatStreaming(
  messages,
  contextDescription,
  images,
  options,
) {
  const body = {
    messages,
    contextDescription,
    images,
    skipRefine: true,
    stream: true,
    practiceContext: options?.practiceContext,
    chatGuidance: options?.chatGuidance,
    hasImages: options?.hasImages,
    aiTask: options?.aiTask,
  }

  const bodyJson = JSON.stringify(body)
  if (bodyJson.length > 5_200_000) {
    throw new Error('이미지·대화가 너무 큽니다. 사진 수를 줄여 주세요.')
  }

  const timeoutMs = isProductionDeploy() ? 90_000 : 180_000

  options?.onStatus?.('Pro 분석 연결 중…')

  const res = await fetch(getChatApiUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/x-ndjson',
    },
    body: bodyJson,
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!res.ok) {
    throw new Error(parseApiError(await res.text(), res.status))
  }

  const ctype = res.headers.get('content-type') || ''
  if (!ctype.includes('ndjson') || !res.body) {
    const data = JSON.parse(await res.text())
    const text = data.choices?.[0]?.message?.content?.trim()
    if (!text) throw new Error('AI가 빈 답변을 반환했습니다.')
    return text
  }

  // 서버는 스트리밍, 화면에는 완성된 답만 한 번에 표시
  const { text } = await consumeNdjsonStream(res.body, {
    onStatus: (msg) => options?.onStatus?.(msg),
  })

  if (!text) {
    throw new Error('AI가 빈 답변을 반환했습니다.')
  }
  return text
}

export async function sendOpenAiChat(
  messages,
  contextDescription,
  images,
  options = {},
) {
  return await withAutoRetry(
    () =>
      sendOpenAiChatStreaming(
        messages,
        contextDescription,
        images,
        options,
      ),
    options,
  )
}
