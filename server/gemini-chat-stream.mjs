/**
 * Gemini streamGenerateContent → NDJSON (Vercel·로컬 스트리밍)
 */
import { prepareGeminiChatRequest } from './gemini-chat-core.mjs'

/** @param {unknown} obj */
function extractChunkText(obj) {
  const parts = obj?.candidates?.[0]?.content?.parts
  if (!Array.isArray(parts)) return ''
  return parts
    .filter((p) => p && p.thought !== true)
    .map((p) => (typeof p?.text === 'string' ? p.text : ''))
    .join('')
}

/**
 * @param {ReadableStream<Uint8Array>} body
 * @param {(chunk: string) => void} onText
 */
async function consumeGeminiSseStream(body, onText) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let full = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })

    const lines = buf.split(/\r?\n/)
    buf = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed === 'data: [DONE]') continue

      let jsonStr = trimmed
      if (jsonStr.startsWith('data:')) {
        jsonStr = jsonStr.slice(5).trim()
      }

      if (!jsonStr || jsonStr === '[' || jsonStr === ']') continue

      try {
        const j = JSON.parse(jsonStr)
        const chunk = extractChunkText(j)
        if (chunk) {
          full += chunk
          onText(chunk)
        }
      } catch {
        /* 불완전한 SSE 조각 */
      }
    }
  }

  const tail = buf.trim()
  if (tail.startsWith('data:')) {
    try {
      const j = JSON.parse(tail.slice(5).trim())
      const chunk = extractChunkText(j)
      if (chunk) {
        full += chunk
        onText(chunk)
      }
    } catch {
      /* ignore */
    }
  }

  return full.trim()
}

/**
 * @param {NonNullable<Awaited<ReturnType<typeof prepareGeminiChatRequest>>>} prep
 * @param {string} model
 * @param {(obj: object) => void} push
 */
async function streamOneModel(prep, model, push) {
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
      const j = JSON.parse(raw)
      msg = j.error?.message || raw
    } catch {
      /* ignore */
    }
    return { ok: false, status: res.status, message: String(msg || '') }
  }

  if (!res.body) {
    return { ok: false, status: 502, message: 'empty_response' }
  }

  const full = await consumeGeminiSseStream(res.body, (chunk) => {
    push({ event: 'chunk', text: chunk })
  })

  if (!full) {
    return { ok: false, status: 502, message: 'empty_response' }
  }

  return { ok: true, text: full, model }
}

/**
 * @param {object} body
 * @param {Record<string, string | undefined>} env
 * @param {(obj: object) => void} push
 */
export async function runGeminiChatStreamToPush(body, env, push) {
  const prep = await prepareGeminiChatRequest(body, env)
  if (!prep.ok) {
    let msg = '요청에 실패했습니다.'
    try {
      const j = JSON.parse(prep.body)
      msg = j.error?.message || msg
    } catch {
      /* ignore */
    }
    push({ event: 'error', message: msg })
    return
  }

  const proMode = prep.modelCandidatesRun.some((m) => /pro/i.test(m))
  push({
    event: 'status',
    message: proMode
      ? 'Pro 모델로 분석 중… (스트리밍)'
      : '회로·사진을 분석하는 중입니다…',
  })

  const pingMs = proMode ? 800 : 2000
  const pingTimer = setInterval(() => push({ event: 'ping' }), pingMs)

  let lastMsg = 'AI가 답변을 만들지 못했습니다.'
  try {
    for (const model of prep.modelCandidatesRun) {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          push({ event: 'status', message: `다시 시도 중… (${attempt + 1}/3)` })
          await new Promise((r) => setTimeout(r, 1500 * attempt))
        }

        try {
          const hit = await streamOneModel(prep, model, push)
          if (hit.ok && hit.text) {
            clearInterval(pingTimer)
            push({
              event: 'done',
              text: hit.text,
              model: hit.model || model,
            })
            return
          }
          lastMsg = hit.message || lastMsg
          const retryable =
            hit.status === 429 ||
            hit.status === 503 ||
            hit.status === 502 ||
            /overloaded|unavailable|high demand|try again|empty_response/i.test(
              lastMsg,
            )
          if (!retryable) break
        } catch (e) {
          lastMsg = e instanceof Error ? e.message : String(e)
          if (!/timeout|abort|503|429|overloaded/i.test(lastMsg)) break
        }
      }
    }

    clearInterval(pingTimer)
    push({ event: 'error', message: lastMsg })
  } catch (e) {
    clearInterval(pingTimer)
    push({
      event: 'error',
      message: e instanceof Error ? e.message : String(e),
    })
  }
}
