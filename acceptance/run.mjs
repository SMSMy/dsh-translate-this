/**
 * run.mjs — the acceptance gate, driven through the DevTools protocol.
 *
 * Why not `chrome --dump-dom`: in that mode the renderer never composites, so
 * `requestAnimationFrame` never fires (measured: 0 frames in 1500 ms). A page judged
 * that way is judged on its fallback scheduler alone — and an earlier run scored 0/5
 * while proving nothing at all about the layer. Here Chrome runs as a real (headless)
 * browser, the page is opened normally, and we read `window.__ACCEPTANCE__`: the same
 * numbers a human sees in the page.
 *
 * It runs the page twice on purpose — once with frames (`requestAnimationFrame`) and
 * once with `?noraf=1`, which forces the fallback scheduler. Both are real states of
 * the product (a backgrounded window gets no frames), so both must pass.
 *
 * Zero dependencies: node's global fetch + WebSocket against Chrome's own endpoint.
 *
 * Usage:
 *   node acceptance/run.mjs [--modes raf,noraf] [--port 19555] [--timeout 60000]
 *                           [--url <page url>] [--chrome <path>] [--json] [--verbose]
 *                           [--keep-profile]
 * Exit code: 0 = every mode passed · 1 = a check failed · 2 = the harness itself broke.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
// The page loads `../lib/client.js` — the file that ships — so the server must span the
// repository, not just this folder. A root that stops at `acceptance/` is what would
// turn the gate into a page measuring nothing.
const ROOT = resolve(HERE, '..')
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i === -1 ? fallback : args[i + 1]
}
const has = (name) => args.includes('--' + name)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PORT = Number(argOf('port', '19555'))
const PAGE = argOf('url', `http://127.0.0.1:${PORT}/acceptance/index.html`)
const TIMEOUT = Number(argOf('timeout', '60000'))
const MODES = String(argOf('modes', 'raf,noraf')).split(',').map((s) => s.trim()).filter(Boolean)
const JSON_OUT = has('json')
const VERBOSE = has('verbose')
const KEEP_PROFILE = has('keep-profile')
const SHOTS = argOf('shots', null)      // write PNG evidence here (drives the page's own buttons)

function defaultChrome() {
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
const CHROME = argOf('chrome', defaultChrome())

/* ------------------------------------------------------------------ environment --- */
async function reachable(url) {
  try { const r = await fetch(url, { method: 'GET' }); return r.ok } catch { return false }
}

/** Bring up the static server if nobody is serving the page yet. */
async function ensureServer() {
  if (await reachable(PAGE)) return null
  const child = spawn(process.execPath, [join(HERE, 'serve.mjs'), '--port', String(PORT), '--root', ROOT], { stdio: 'ignore' })
  for (let i = 0; i < 120; i += 1) {
    if (await reachable(PAGE)) return child
    await sleep(100)
  }
  child.kill()
  throw new Error(`no server answered on ${PAGE} and serve.mjs could not start one`)
}

async function launchChrome(profile) {
  // `--disable-extensions`: an extension's own content scripts show up in resource
  // timing and would be counted as "the page made a request" (measured with AdGuard).
  // The check itself no longer depends on that, but a gate should not measure the
  // reviewer's browser setup.
  const child = spawn(CHROME, [
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

function killTree(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else child.kill('SIGKILL')
}

/* ---------------------------------------------------------------- devtools glue --- */
function client(ws) {
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
    }
  }
}

async function openTab(port, url) {
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

const pageErrors = (api) => {
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

/* ---------------------------------------------------------------- visual proof ---
   The DOM metrics say the Arabic text is there; a screenshot is what a reviewer
   actually looks at, and it is the only thing that can show a *flicker* is absent
   rather than merely unmeasured. We drive the page's own buttons (the same two-batch
   streaming rewrite check 1 uses) and capture a PNG at each step. */
async function visualEvidence(api, dir) {
  await mkdir(dir, { recursive: true })
  const evaluate = async (expression) =>
    (await api.send('Runtime.evaluate', { expression, returnByValue: true })).result?.value
  const shot = async (name) => {
    const res = await api.send('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(dir, name), Buffer.from(res.data, 'base64'))
  }
  const isArabic = async (id) => /[\u0600-\u06FF]/.test(String(await evaluate(`document.getElementById('${id}').textContent`)))
  const steps = {}
  await evaluate(`document.getElementById('reset').click()`)
  await sleep(150)
  await evaluate(`document.getElementById('translateAll').click()`)
  await sleep(350)
  steps.afterTranslate = await isArabic('b1t')
  await shot('1-translated.png')
  await evaluate(`document.getElementById('streamBatches').click()`)   // rewrites the source twice
  await sleep(800)
  steps.afterTwoStreamingBatches = await isArabic('b1t')
  await shot('2-after-two-streaming-batches.png')
  await evaluate(`document.getElementById('restoreAll').click()`)
  await sleep(250)
  steps.restoredText = await evaluate(`document.getElementById('b1t').textContent`)
  await shot('3-restored.png')
  return steps
}

/* -------------------------------------------------------------------- one mode --- */
async function runMode(port, mode, shotsDir) {
  const sep = PAGE.includes('?') ? '&' : '?'
  const url = `${PAGE}${sep}auto=1${mode === 'noraf' ? '&noraf=1' : ''}${mode === 'nobs' ? '&nobs=1' : ''}`
  const ws = await openTab(port, url)
  const api = client(ws)
  await api.send('Runtime.enable')
  await api.send('Log.enable')
  await api.send('Page.enable')

  const evaluate = async (expression) => {
    const res = await api.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false })
    if (res.exceptionDetails) return { error: res.exceptionDetails.text }
    return { value: res.result?.value }
  }

  const deadline = Date.now() + TIMEOUT
  let verdict = null
  let title = ''
  while (Date.now() < deadline) {
    const probe = await evaluate('window.__ACCEPTANCE__ ? JSON.stringify(window.__ACCEPTANCE__) : null')
    const t = await evaluate('document.title || ""')
    title = t.value || title
    if (probe.value) {
      // The page publishes `{ results, counters }`; pass/total are derived here so the
      // gate's verdict is computed from the per-check results, never restated by hand.
      const raw = JSON.parse(probe.value)
      const results = Array.isArray(raw.results) ? raw.results : []
      verdict = {
        results,
        counters: raw.counters || {},
        pass: results.filter((r) => r.ok).length,
        total: results.length
      }
      break
    }
    await sleep(150)
  }

  let dump = null
  if (!verdict) {
    const d = await evaluate(`(function(){
      const t = document.getElementById('verdict');
      const log = document.getElementById('log');
      const rows = Array.from(document.querySelectorAll('#results tbody tr'))
        .map((tr) => Array.from(tr.children).map((td) => td.textContent).join(' | '));
      return JSON.stringify({ title: document.title, verdictLine: t ? t.textContent : null,
                              log: log ? log.textContent : null, rows })
    })()`)
    dump = d.value ? JSON.parse(d.value) : { note: 'page did not answer' }
  }

  let visual = null
  if (verdict && shotsDir) visual = await visualEvidence(api, shotsDir)
  const errors = pageErrors(api)
  ws.close()
  return { mode, url, verdict, title, dump, errors, visual }
}

/* ---------------------------------------------------------------------- report --- */
function reportMode(r) {
  const head = `── ${r.mode === 'raf' ? 'frames (requestAnimationFrame)' : r.mode === 'nobs' ? 'observer OFF (?nobs=1)' : 'fallback scheduler (?noraf=1)'}`
  if (!r.verdict) {
    console.log(`${head}\n   NO VERDICT within the timeout — the page never finished.`)
    if (r.dump) {
      console.log(`   title: ${r.dump.title}`)
      if (r.dump.verdictLine) console.log(`   verdict: ${r.dump.verdictLine}`)
      for (const row of r.dump.rows || []) console.log(`   ${row}`)
      if (r.dump.log) console.log(`   log: ${r.dump.log.trim().split('\n').slice(-3).join(' / ')}`)
    }
    if (r.errors.length) console.log('   page errors:\n' + r.errors.map((e) => '     ' + e).join('\n'))
    return false
  }
  const v = r.verdict
  const ok = v.pass === v.total
  console.log(`${head}   ${v.pass}/${v.total} ${ok ? 'PASS' : 'FAIL'}`)
  for (const c of v.results) console.log(`   [${c.ok ? 'PASS' : 'FAIL'}] ${c.name}\n          ${c.detail}`)
  const c = v.counters
  console.log(`   counters: requests=${c.requests} injections=${c.injections} reinjections=${c.reinjections} ` +
              `giveUps=${c.giveUps} droppedLate=${c.droppedLate} flickerMs=${c.flickerMs} network=${c.network}`)
  if (r.visual) {
    console.log(`   visual: arabic after translate=${r.visual.afterTranslate} · after two streaming batches=${r.visual.afterTwoStreamingBatches}`)
    console.log(`   restored text: ${JSON.stringify(r.visual.restoredText)}`)
  }
  if (r.errors.length) console.log('   page errors:\n' + r.errors.map((e) => '     ' + e).join('\n'))
  return ok
}

/* ------------------------------------------------------------------------ main --- */
let server = null
let chrome = null
let profile = null
let code = 2
try {
  server = await ensureServer()
  profile = await mkdtemp(join(tmpdir(), 'dct-gate-'))
  const launched = await launchChrome(profile)
  chrome = launched.child
  const results = []
  for (const mode of MODES) {
    const r = await runMode(launched.port, mode, SHOTS ? join(SHOTS, mode) : null)
    results.push(r)
    if (JSON_OUT) console.log(JSON.stringify(r))
    else reportMode(r)
  }
  const passed = results.filter((r) => r.verdict && r.verdict.pass === r.verdict.total).length
  const verdicts = results.map((r) => ({ mode: r.mode, pass: r.verdict?.pass ?? 0, total: r.verdict?.total ?? 0, errors: r.errors }))
  if (!JSON_OUT) {
    console.log(`\n${passed}/${results.length} mode(s) fully passed  ${passed === results.length ? '· GATE OPEN' : '· GATE CLOSED'}`)
    for (const v of verdicts) console.log(`   ${v.mode}: ${v.pass}/${v.total}`)
  } else {
    console.log(JSON.stringify({ modes: verdicts, passed, total: results.length }))
  }
  code = passed === results.length ? 0 : 1
} catch (err) {
  console.error('harness error: ' + (err && err.message ? err.message : String(err)))
  code = 2
} finally {
  killTree(chrome)
  if (server) killTree(server)
  if (profile && !KEEP_PROFILE) await rm(profile, { recursive: true, force: true }).catch(() => {})
}
process.exit(code)
