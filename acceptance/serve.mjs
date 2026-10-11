/**
 * serve.mjs — a zero-dependency static server for the acceptance page.
 *
 * Why it exists: browsers refuse to run a page from `file://` in the environments
 * we verify in, and the page must stay standalone (it imports nothing). This file
 * is *not* imported by the page — it only hands it over HTTP so a real browser can
 * open it, exactly as it would be opened in a review.
 *
 * Run: node acceptance/serve.mjs [--port 19555] [--root <dir>]
 *
 * The root matters: the acceptance page loads `../lib/client.js` — the plugin file that
 * ships — so the server has to span the repository, not just this folder:
 *   node acceptance/serve.mjs --port 19555 --root .
 *   → http://127.0.0.1:19555/acceptance/index.html
 * (Default root is this folder, which is enough only for a page that imports nothing.)
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i === -1 ? fallback : args[i + 1]
}
const HERE = fileURLToPath(new URL('.', import.meta.url))
const root = resolve(argOf('root', HERE))
const port = Number(argOf('port', '19555'))

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8'
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(String(req.url || '/'), 'http://x')
    let pathname = decodeURIComponent(url.pathname)
    // The browser asks for an icon nobody published. Answering 204 keeps a real 404 out
    // of the console: a gate that reports "page errors" must not report its own noise.
    if (pathname === '/favicon.ico') { res.writeHead(204).end(); return }
    if (pathname === '/' || pathname.endsWith('/')) pathname += 'index.html'
    const target = resolve(join(root, pathname))
    // containment: never serve anything outside the root
    if (target !== root && !target.startsWith(root + sep)) {
      res.writeHead(403).end('outside root')
      return
    }
    const info = await stat(target)
    if (!info.isFile()) { res.writeHead(404).end('not a file'); return }
    const body = await readFile(target)
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store'
    })
    res.end(body)
  } catch (err) {
    res.writeHead(404).end('not found')
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`acceptance page: http://127.0.0.1:${port}/index.html   (root: ${root})`)
})
