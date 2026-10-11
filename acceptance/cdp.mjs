/**
 * cdp.mjs — the DevTools plumbing shared by the acceptance gate and the GUI probe.
 *
 * It exists so there is exactly ONE implementation of "start Chrome headless, open a
 * page, evaluate an expression": the gate (`run.mjs`) and the live-GUI probe
 * (`tools/gui-probe.mjs`) both need it, and a second copy would drift the same way the
 * layer's second copy would have.
 *
 * Zero dependencies: node's global fetch + WebSocket against Chrome's own endpoint.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function defaultChrome() {
  const candidates = [
    process.env.DCT_CHROME,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean)
  return candidates.find((p) => existsSync(p)) || 'chrome'
}

/**
 * Start a headless Chrome with the DevTools endpoint on an ephemeral port.
 * `--disable-extensions` is not cosmetic: an extension injects its own content scripts,
 * which show up in resource timing and would be counted as "requests the page made"
 * (measured with AdGuard on this machine).
 */
export async function launchChrome(profile, chromePath = defaultChrome()) {
  const child = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank'
  ], { stdio: 'ignore' })
  const portFile = join(profile, 'DevToolsActivePort')
  for (let i = 0; i < 300; i += 1) {
    if (existsSync(portFile)) {
      const [port] = (await readFile(portFile, 'utf8')).split('\n')
      if (port) return { child, port: Number(port) }
    }
    if (child.exitCode !== null) throw new Error(`chrome exited early (code ${child.exitCode})`)
    await sleep(50)
  }
  throw new Error('chrome never wrote DevToolsActivePort')
}

export function killTree(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else child.kill('SIGKILL')
}

/** A minimal CDP client: request/response ids plus the raw event stream. */
export function client(ws) {
  let next = 0
  const pending = new Map()
  const events = []
  ws.addEventListener('message', (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result)
    } else if (msg.method) {
      events.push(msg)
    }
  })
  return {
    events,
    send(method, params = {}) {
      const id = (next += 1)
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    /** Evaluate in the page and return the value (or an {error} object, never a throw). */
    async evaluate(expression) {
      const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (res.exceptionDetails) return { error: res.exceptionDetails.text }
      if (res.result?.subtype === 'error') return { error: res.result.description || 'evaluation failed' }
      return { value: res.result?.value }
    }
  }
}

export async function openTab(port, url) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  if (!res.ok) throw new Error(`could not open a tab (HTTP ${res.status}); is this Chrome new enough for PUT /json/new?`)
  const target = await res.json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('devtools socket failed to open')), { once: true })
  })
  return ws
}

/** Page errors collected from the CDP event stream (exceptions + console/log errors). */
export function pageErrors(api) {
  const out = []
  for (const e of api.events) {
    if (e.method === 'Runtime.exceptionThrown') {
      const d = e.params.exceptionDetails
      out.push('exception: ' + (d.exception?.description || d.text || '').split('\n')[0])
    } else if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') {
      out.push('log: ' + e.params.entry.text.split('\n')[0])
    } else if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') {
      out.push('console: ' + e.params.args.map((a) => a.value ?? a.description ?? '').join(' ').split('\n')[0])
    }
  }
  return [...new Set(out)].slice(0, 8)
}
