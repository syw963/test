import { defineConfig } from 'vite'
import type { Plugin, ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import { createReadStream, cpSync, existsSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, extname, join, normalize, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = dirname(fileURLToPath(import.meta.url))
const pdfjsDir = join(rootDir, 'node_modules/pdfjs-dist')

function mimeType(filePath: string): string {
  const ext = extname(filePath)
  if (ext === '.bcmap') return 'application/octet-stream'
  if (ext === '.mjs' || ext === '.js') return 'text/javascript'
  if (ext === '.ttf') return 'font/ttf'
  if (ext === '.pfb') return 'application/octet-stream'
  if (ext === '.wasm') return 'application/wasm'
  return 'application/octet-stream'
}

function pdfJsAssets(): Plugin {
  return {
    name: 'local-pdfjs-assets',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/pdfjs/', (
        request: IncomingMessage,
        response: ServerResponse,
        next: () => void,
      ) => {
        const url = new URL(request.url ?? '/', 'http://local')
        const requested = decodeURIComponent(url.pathname.replace(/^\/pdfjs\//, ''))
        const filePath = normalize(join(pdfjsDir, requested))
        if (relative(pdfjsDir, filePath).startsWith('..') || !existsSync(filePath) || !statSync(filePath).isFile()) {
          next()
          return
        }
        response.setHeader('Content-Type', mimeType(filePath))
        createReadStream(filePath).pipe(response)
      })
    },
    writeBundle() {
      for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
        cpSync(join(pdfjsDir, dir), join(rootDir, 'dist/pdfjs', dir), { recursive: true })
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  optimizeDeps: {
    exclude: ['mupdf'],
  },
  plugins: [react(), pdfJsAssets()],
})
