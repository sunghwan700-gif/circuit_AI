import { runGeminiChatProxy } from '../../server/gemini-chat-core.mjs'

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: { message: 'Method Not Allowed' } }),
    }
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: { message: 'Invalid JSON' } }),
    }
  }

  const result = await runGeminiChatProxy(body, process.env)
  return {
    statusCode: result.statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: result.body,
  }
}
