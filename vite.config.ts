import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'
import type { OutputBundle } from 'rollup'
import type { Plugin } from 'vite'

/* Static JS imports of a chunk, transitively: what its first load fetches. */
function chunkClosure(bundle: OutputBundle, file: string, into = new Set<string>()): Set<string> {
  const chunk = bundle[file]
  if (!chunk || chunk.type !== 'chunk' || into.has(file)) return into
  into.add(file)
  for (const dep of chunk.imports) chunkClosure(bundle, dep, into)
  return into
}

/* Cuts two round trips off first paint: preloads the UI font every screen
   renders with, and on /c/ routes starts the canvas page's chunks alongside
   the entry instead of after it has run. */
function bootPreloads(): Plugin {
  return {
    name: 'doop-boot-preloads',
    apply: 'build',
    transformIndexHtml(_html, ctx) {
      const bundle = ctx.bundle
      if (!bundle) return
      const files = Object.values(bundle)
      const font = files.find(
        (f) => f.type === 'asset' && f.originalFileNames.some((n) => n.endsWith('/instrument-sans-latin.woff2')),
      )
      const entry = files.find((f) => f.type === 'chunk' && f.isEntry)
      /* facadeModuleId is null for this dynamic entry, so match on its modules */
      const canvas = files.find(
        (f) =>
          f.type === 'chunk' && f.isDynamicEntry && f.moduleIds.some((m) => m.endsWith('/src/pages/CanvasPage.tsx')),
      )
      const tags = []
      if (font) {
        tags.push({
          tag: 'link',
          attrs: { rel: 'preload', href: `/${font.fileName}`, as: 'font', type: 'font/woff2', crossorigin: '' },
          injectTo: 'head' as const,
        })
      }
      if (canvas && entry) {
        const loaded = chunkClosure(bundle, entry.fileName)
        const hrefs = [...chunkClosure(bundle, canvas.fileName)].filter((f) => !loaded.has(f)).map((f) => `/${f}`)
        tags.push({
          tag: 'script',
          children: `if(/^\\/c\\//.test(location.pathname))${JSON.stringify(hrefs)}.forEach(function(h){var l=document.createElement('link');l.rel='modulepreload';l.href=h;document.head.appendChild(l)})`,
          injectTo: 'head' as const,
        })
      }
      return tags
    },
  }
}

/* Brotli and gzip copies of every built text asset, written once at build
   time so the server never compresses per request (see server/index.ts). */
function precompress(): Plugin {
  let outDir = 'dist'
  return {
    name: 'doop-precompress',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir
    },
    closeBundle() {
      const dir = path.resolve(outDir, 'assets')
      for (const name of readdirSync(dir)) {
        if (!/\.(js|css|svg|json|txt|html|wasm)$/.test(name)) continue
        const file = path.join(dir, name)
        if (statSync(file).size < 1024) continue
        const body = readFileSync(file)
        writeFileSync(`${file}.br`, brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }))
        writeFileSync(`${file}.gz`, gzipSync(body, { level: 9 }))
      }
    },
  }
}

/* Dev ports. The defaults are the only ones anyone normally needs; the env
   overrides exist so a second worktree can run its own pair without fighting
   the first for :4300/:4400. PORT is the same variable the server reads, so
   the proxy always points at whichever backend this `npm run dev` started. */
const apiPort = Number(process.env.PORT || 4400)
const webPort = Number(process.env.VITE_PORT || 4300)
const api = `http://localhost:${apiPort}`

export default defineConfig({
  plugins: [react(), tailwindcss(), bootPreloads(), precompress()],
  /* fonts stay files: an inlined subset would ship in the CSS to everyone */
  build: { assetsInlineLimit: (file) => (file.endsWith('.woff2') ? false : undefined) },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: webPort,
    /* cargo's build output is huge and, on Windows, its binaries stay locked
       while the shell runs (EBUSY); nothing under it is ever served by vite */
    watch: {
      ignored: ['**/desktop/src-tauri/target/**'],
    },
    /* the doop-sync snippet posts to /ingest from foreign origins; vite
       answers CORS preflights itself before the proxy, so its default
       same-origin policy would block what the express server (prod) allows */
    cors: true,
    proxy: {
      /* changeOrigin stays OFF so the backend sees the web origin's Host and
         better-auth builds OAuth discovery/authorize URLs on that origin —
         the one that serves the login page and that MCP clients connect to */
      '/api': { target: api },
      '/mcp': { target: api },
      '/local-agent': { target: api },
      /* frame images only — a bare '/i' prefix would swallow /integrations */
      '/i/': { target: api },
      '/a/': { target: api },
      '/u/': { target: api },
      '/ingest': { target: api },
      '/relay': { target: api },
      '/blog': { target: api },
      '/robots.txt': { target: api },
      '/sitemap.xml': { target: api },
      '/.well-known': { target: api },
      '/ws': { target: `ws://localhost:${apiPort}`, ws: true },
    },
  },
})
