/**
 * Vercel api/* 가 server/*.mjs 를 안정적으로 로드하도록 빌드 시 번들
 */
import * as esbuild from 'esbuild'
import { mkdirSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = resolve(ROOT, 'api/_bundled')

mkdirSync(OUT_DIR, { recursive: true })

const shared = {
  platform: 'node',
  target: 'node20',
  format: 'esm',
  bundle: true,
  packages: 'external',
  logLevel: 'info',
}

await esbuild.build({
  ...shared,
  absWorkingDir: ROOT,
  entryPoints: [resolve(ROOT, 'server/submissions-handler.mjs')],
  outfile: resolve(OUT_DIR, 'submissions-handler.mjs'),
})

await esbuild.build({
  ...shared,
  absWorkingDir: ROOT,
  entryPoints: [resolve(ROOT, 'server/vercel-gemini-entry.mjs')],
  outfile: resolve(OUT_DIR, 'gemini-api.mjs'),
})

await esbuild.build({
  ...shared,
  absWorkingDir: ROOT,
  entryPoints: [resolve(ROOT, 'server/vercel-http-entry.mjs')],
  outfile: resolve(OUT_DIR, 'http-utils.mjs'),
})

console.log('Vercel API bundles written to api/_bundled/')
