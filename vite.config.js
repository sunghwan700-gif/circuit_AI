import { spawn } from 'child_process'
import { resolve, join } from 'path'
import { fileURLToPath } from 'url'
import { defineConfig, loadEnv } from 'vite'
import {
  runGeminiChatProxy,
  runGeminiChatWithHeartbeat,
} from './server/gemini-chat-core.mjs'
import { createPendingAiChatJob, readAiChatJob } from './server/ai-chat-jobs.mjs'
import { processAiChatJob } from './server/process-ai-chat-job.mjs'
import {
  applySubmissionEnvDefaults,
  loadEnvForMode,
} from './server/load-env.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const SYNC_PORT = Number(process.env.SUBMISSIONS_SYNC_PORT || 8787)

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const isDev = mode === 'development'
  const submissionsSameOrigin =
    env.VITE_SUBMISSIONS_SAME_ORIGIN === 'true' ||
    (isDev && !env.VITE_SUBMISSIONS_API_URL)

  return {
    env: {
      // dev에서 .env.development 없이도 같은 출처 API 사용
      ...(submissionsSameOrigin && !env.VITE_SUBMISSIONS_SAME_ORIGIN
        ? { VITE_SUBMISSIONS_SAME_ORIGIN: 'true' }
        : {}),
    },
    server: {
      host: true,
      proxy:
        isDev && submissionsSameOrigin && !env.VITE_SUBMISSIONS_API_URL
          ? {
              '/api/submissions': {
                target: `http://127.0.0.1:${SYNC_PORT}`,
                changeOrigin: true,
              },
              '/api/auth': {
                target: `http://127.0.0.1:${SYNC_PORT}`,
                changeOrigin: true,
              },
            }
          : undefined,
    },
    plugins: [
      {
        name: 'submissions-sync-dev',
        apply: 'serve',
        configureServer(server) {
          if (!submissionsSameOrigin || env.VITE_SUBMISSIONS_API_URL) return

          loadEnvForMode('development')
          applySubmissionEnvDefaults()

          const childEnv = {
            ...process.env,
            PORT: String(SYNC_PORT),
            SUBMISSIONS_STUDENT_TOKEN:
              process.env.SUBMISSIONS_STUDENT_TOKEN ||
              process.env.VITE_SUBMISSIONS_STUDENT_TOKEN ||
              'circuit-class-submit',
            SUBMISSIONS_TEACHER_PASSWORD:
              process.env.SUBMISSIONS_TEACHER_PASSWORD ||
              process.env.VITE_TEACHER_PASSWORD ||
              '',
          }

          const child = spawn(
            process.execPath,
            [join(__dirname, 'server/submissions-server.mjs')],
            { env: childEnv, stdio: 'inherit' },
          )

          const stop = () => {
            if (!child.killed) child.kill()
          }
          server.httpServer?.on('close', stop)
          process.on('exit', stop)

          child.on('error', (err) => {
            console.error('[submissions-sync] sync-server 시작 실패:', err)
          })
        },
      },
      {
        name: 'openai-chat-proxy',
        configureServer(server) {
          server.httpServer?.on('listening', () => {
            if (!server.httpServer) return
            server.httpServer.requestTimeout = 0
            server.httpServer.headersTimeout = 0
          })

          server.middlewares.use(async (req, res, next) => {
            const url = req.url || ''
            const pathname = url.split('?')[0] || ''

            if (pathname === '/api/openai/chat/job') {
              if (req.method === 'GET') {
                const q = new URL(url, 'http://localhost')
                const jobId = q.searchParams.get('jobId') || ''
                const job = await readAiChatJob(jobId)
                res.statusCode = job ? 200 : 404
                res.setHeader('Content-Type', 'application/json; charset=utf-8')
                res.end(
                  JSON.stringify(
                    job || { error: { message: 'Job not found' } },
                  ),
                )
                return
              }
              if (req.method === 'POST') {
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
                const jobId = await createPendingAiChatJob(body)
                void processAiChatJob(jobId, body, env)
                res.statusCode = 202
                res.setHeader('Content-Type', 'application/json; charset=utf-8')
                res.end(JSON.stringify({ jobId, status: 'pending' }))
                return
              }
            }

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
