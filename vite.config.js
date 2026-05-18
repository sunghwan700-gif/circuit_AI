import { resolve } from 'path'
import { defineConfig, loadEnv } from 'vite'
import {
  runGeminiChatProxy,
  runGeminiChatWithHeartbeat,
} from './server/gemini-chat-core.mjs'

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

            if (body.stream !== false) {
              res.statusCode = 200
              res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
              res.setHeader('Cache-Control', 'no-cache')
              res.setHeader('Connection', 'keep-alive')
              const push = (obj) => {
                res.write(`${JSON.stringify(obj)}\n`)
              }
              await runGeminiChatWithHeartbeat(body, env, push)
              res.end()
              return
            }

            const result = await runGeminiChatProxy(body, env)
            res.statusCode = result.statusCode
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(result.body)
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
