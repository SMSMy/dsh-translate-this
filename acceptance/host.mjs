/**
 * host.mjs — the host half's own gate (post-0.8 hardening).
 *
 * Why a third gate: `acceptance/run.mjs` judges the LAYER in a browser, and
 * `acceptance/protocol.mjs` judges the splitter and the alignment maths in node. Neither one
 * ever mounts `lib/index.js`, so every defect an external evaluation found in the host half
 * lived under BOTH gates: a client that walked away kept paying for a model call that nobody
 * was reading, an invalid body answered `EMPTY` ("no text to translate"), an oversized body
 * never answered at all, a segment carrying the batch separator was sent to the model verbatim,
 * and `DCT_AGENT_SKILL=1` killed the whole fiber — engine route included.
 *
 * This gate mounts the REAL `apply()` from `lib/index.js` on a REAL `node:http` server with a
 * fake `ctx` and a fake `llm.stream`: hermetic — no Chrome, no network, no model, no tokens.
 * Every check below fails on the code that shipped 0.8, and each one prints numbers.
 *
 * Usage: node acceptance/host.mjs [--port 0] [--verbose]
 *
 * The last check mounts the plugin on the REAL cordis framework with the REAL `dsh-skill`
 * service when the installed DSH tree is present; when it is not, the check says `[SKIP]` out
 * loud with its reason (a silent skip is what this project refuses).
 *
 * Exit 0 = every check passed · 1 = a named check failed · 2 = the harness itself broke.
 */
import { createServer, request as httpRequest } from 'node:http'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const args = process.argv.slice(2)
const argOf = (name, fallback) => { const i = args.indexOf('--' + name); return i === -1 ? fallback : args[i + 1] }
const VERBOSE = args.includes('--verbose')
const PORT = Number(argOf('port', '0'))

const HOST = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
const { apply, inject } = HOST
const ROUTE = '/dsh-translate-this'

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}\n        ${detail}`)
  return !!ok
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const hashOf = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').toUpperCase()

/* ------------------------------------------------------------------- the fake host --- */

/**
 * A `ctx` that keeps the three declared services, throws exactly like cordis does for the ONE
 * service we deliberately do not declare (`cannot get property "skills" without inject` —
 * measured on the shipped framework), and records everything the plugin does.
 */
function fakeHost ({ stream, skills = null, skillsThrows = true } = {}) {
  const state = { routes: [], effects: [], logs: [], streamCalls: 0 }
  const ctx = {
    logger: {
      info: (m) => state.logs.push(String(m)),
      warn: (m) => state.logs.push(String(m)),
      debug: (m) => state.logs.push(String(m)),
      error: (m) => state.logs.push(String(m))
    },
    effect (fn, label) { const d = fn(); state.effects.push({ label, dispose: typeof d === 'function' ? d : null }); return () => {} },
    get (name) { return name === 'skills' ? skills : undefined },
    webServer: { register (route) { state.routes.push(route); return () => {} } },
    llm: {
      stream: (options) => {
        state.streamCalls += 1
        // Record WHEN the abort reached the model call: "no chunk after the abort" is the
        // honest criterion. "No chunk after the socket died" is not — how fast a dead socket is
        // noticed is the OS's business, not this plugin's (measured: ~410ms in close-probe).
        try { options?.signal?.addEventListener?.('abort', () => { generatorState.abortedAt = Date.now(); generatorState.aborted = true }) } catch { /* no signal */ }
        return stream(options)
      },
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }], defaultEffort: 'high' } })
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }
  }
  if (skillsThrows) {
    Object.defineProperty(ctx, 'skills', { get () { throw new Error('cannot get property "skills" without inject') } })
  }
  return { ctx, state }
}

/** Mount the plugin's real apply() and return the route handler it registered. */
function mount (host) {
  const before = process.env.DCT_AGENT_SKILL
  apply(host.ctx)
  if (before === undefined) delete process.env.DCT_AGENT_SKILL; else process.env.DCT_AGENT_SKILL = before
  if (!host.state.routes.length) throw new Error('apply() registered no route')
  return host.state.routes[0].handler
}

/** A batch model that answers honestly: every segment comes back behind its own marker. */
function batchStream () {
  return (options) => ({
    async *[Symbol.asyncIterator] () {
      const first = options?.messages?.[0]?.content
      const payload = String(Array.isArray(first) ? first[0]?.text ?? '' : first ?? '')
      const split = payload.split(/<<<DCT:(\d+)>>>/)
      const pieces = []
      for (let i = 1; i < split.length; i += 2) pieces.push('<<<DCT:' + split[i] + '>>>\nترجمة ' + split[i + 1].trim())
      yield { type: 'text-delta', text: pieces.join('\n') }
      yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 22, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 33 } }
      yield { type: 'finish', reason: 'stop' }
    }
  })
}

/** A model that generates slowly, so a client can walk away while it is still working. */
const generatorState = {}
function slowStream () {
  return (options) => ({
    async *[Symbol.asyncIterator] () {
      for (let i = 0; i < 40; i += 1) {
        if (options?.signal?.aborted) { generatorState.aborted = true; return }
        await sleep(20)
        if (options?.signal?.aborted) { generatorState.aborted = true; return }
        generatorState.yielded = (generatorState.yielded || 0) + 1
        if (generatorState.destroyedAt && Date.now() > generatorState.destroyedAt) generatorState.afterDestroy = (generatorState.afterDestroy || 0) + 1
        if (generatorState.abortedAt && Date.now() > generatorState.abortedAt) generatorState.afterAbort = (generatorState.afterAbort || 0) + 1
        yield { type: 'text-delta', text: 'نصّ طويل رقم ' + i }
      }
      yield { type: 'finish', reason: 'stop' }
    }
  })
}

/**
 * A model whose FIRST token is far away. This fixture exists because an independent verification
 * proved the earlier one could not reach the guard it was supposed to guard: cutting at 220ms
 * against a generator whose first chunk lands at 20ms always leaves the first message shape
 * NON-empty, so the second shape is never attempted. Remove the abort check inside the shapes
 * loop with that fixture and the gate still passes (measured: `8/8 HOST GATE OPEN`). With a late
 * first token the difference is total — measured by the verifier's own probe on five runs:
 * guard present `calls=[1,1,1,1,1]`, guard removed `calls=[1,2,2,1,1]` — a SECOND PAID CALL for a
 * reader who had already left.
 */
function lateStream () {
  return (options) => ({
    async *[Symbol.asyncIterator] () {
      await sleep(350)
      if (options?.signal?.aborted) { generatorState.aborted = true; return }
      for (let i = 0; i < 10; i += 1) {
        if (options?.signal?.aborted) { generatorState.aborted = true; return }
        generatorState.yielded = (generatorState.yielded || 0) + 1
        yield { type: 'text-delta', text: 'متأخّر ' + i }
        await sleep(20)
      }
      yield { type: 'finish', reason: 'stop' }
    }
  })
}

/* ---------------------------------------------------------------------- the server --- */

let handlerRef = () => {}
const server = createServer((req, res) => {
  Promise.resolve(handlerRef(req, res)).catch((error) => {
    try {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: { code: 'HARNESS', message: String(error?.message ?? error) } }))
    } catch { /* the socket is gone; nothing to answer */ }
  })
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
const port = server.address().port

/** One POST; always resolves — with `{ status, body }`, or a named transport failure. */
function postRequest (path, payload, { raw = undefined, handOff = null } = {}) {
  return new Promise((resolvePromise) => {
    const body = raw === undefined ? JSON.stringify(payload) : raw
    let settled = false
    const done = (value) => { if (!settled) { settled = true; resolvePromise(value) } }
    const request = httpRequest({ port, path, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { text += c })
      res.on('end', () => done({ status: res.statusCode, body: text, aborted: false }))
      res.on('aborted', () => done({ status: res.statusCode, body: text, aborted: true }))
    })
    request.on('error', (error) => done({ status: null, body: '', aborted: true, error: String(error?.code || error?.message || error) }))
    if (handOff) handOff(request)
    request.end(body)
  })
}

/** One GET, parsed when it is JSON. */
function getRequest (path) {
  return new Promise((resolvePromise) => {
    const request = httpRequest({ port, path, method: 'GET' }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { text += c })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(text) } catch { json = null }
        resolvePromise({ status: res.statusCode, json, text })
      })
    })
    request.on('error', (error) => resolvePromise({ status: null, json: null, error: String(error?.code || error?.message || error) }))
    request.end()
  })
}

const jsonOf = (text) => { try { return JSON.parse(text) } catch { return null } }

/* --------------------------------------------------------------------- the checks --- */
console.log(`host gate · lib/index.js ${hashOf(join(ROOT, 'lib', 'index.js')).slice(0, 16)}… · lib/creed.js ${hashOf(join(ROOT, 'lib', 'creed.js')).slice(0, 16)}… · port ${port}\n`)

/* H0 — positive control: a healthy batch still works end to end. ------------------------ */
{
  const host = fakeHost({ stream: batchStream() })
  handlerRef = mount(host)
  const res = await postRequest(ROUTE + '/translate', { segments: ['first segment', 'second segment'], target: 'ar' })
  const body = jsonOf(res.body)
  const arabic = !!body?.segments?.every((s) => /[\u0600-\u06FF]/.test(s))
  check('H0 · دفعة سليمة تُترجم فعلًا (الضابط الموجب)',
    res.status === 200 && body?.ok === true && body?.segments?.length === 2 && arabic && host.state.streamCalls === 1,
    `status=${res.status} · ok=${body?.ok} · segments=${body?.segments?.length ?? 'null'} · arabic=${arabic} · streamCalls=${host.state.streamCalls}`)
}

/* H1 — an invalid body must say BAD_JSON, not EMPTY. ----------------------------------- */
{
  const host = fakeHost({ stream: batchStream() })
  handlerRef = mount(host)
  const res = await postRequest(ROUTE + '/translate', null, { raw: '{"segments": [' })
  const body = jsonOf(res.body)
  check('H1 · جسم غير صالح ⇒ BAD_JSON (لا EMPTY)',
    res.status === 400 && body?.error?.code === 'BAD_JSON' && host.state.streamCalls === 0,
    `status=${res.status} · code=${body?.error?.code ?? 'null'} · message="${body?.error?.message ?? ''}" · streamCalls=${host.state.streamCalls}`)
}

/* H2 — an oversized body must ANSWER (413), never hang. -------------------------------- */
{
  const host = fakeHost({ stream: batchStream() })
  handlerRef = mount(host)
  const big = JSON.stringify({ segments: ['x'.repeat(300000)] })
  const started = Date.now()
  const res = await Promise.race([
    postRequest(ROUTE + '/translate', null, { raw: big }),
    sleep(2000).then(() => ({ status: null, body: '', timedOut: true }))
  ])
  const body = jsonOf(res.body)
  check('H2 · جسم 300031 بايت ⇒ 413 BODY_TOO_LARGE خلال ثانيتين (لا تعليق)',
    res.status === 413 && body?.error?.code === 'BODY_TOO_LARGE' && host.state.streamCalls === 0,
    `status=${res.status} · code=${body?.error?.code ?? 'null'} · settledInMs=${Date.now() - started} · timedOut=${!!res.timedOut} · streamCalls=${host.state.streamCalls}`)
}

/* H3 — the batch separator inside the INPUT is refused before any model call. ---------- */
{
  const host = fakeHost({ stream: batchStream() })
  handlerRef = mount(host)
  const res = await postRequest(ROUTE + '/translate', { segments: ['safe segment', 'poisoned <<<DCT:2>>> segment'], target: 'ar' })
  const body = jsonOf(res.body)
  check('H3 · مقطع يحوي <<<DCT ⇒ MARKER_IN_INPUT قبل أي نداء',
    res.status === 400 && body?.error?.code === 'MARKER_IN_INPUT' && host.state.streamCalls === 0,
    `status=${res.status} · code=${body?.error?.code ?? 'null'} · message="${body?.error?.message ?? ''}" · streamCalls=${host.state.streamCalls}`)
}

/* H4 — a client that leaves mid-call stops the call, and does not retry. --------------- */
{
  for (const key of Object.keys(generatorState)) delete generatorState[key]
  const host = fakeHost({ stream: slowStream() })
  handlerRef = mount(host)
  const handOff = (request) => {
    setTimeout(() => { generatorState.destroyedAt = Date.now(); request.destroy() }, 220)
  }
  await postRequest(ROUTE + '/translate', { segments: ['a long reply the client walks away from'], target: 'ar' }, { handOff })
  await sleep(900)
  const log = await getRequest(ROUTE + '/log')
  const calls = log.json?.calls ?? []
  const first = calls[0] || {}
  check('H4 · قطع العميل في منتصف البثّ ⇒ إيقاف المحرّك بلا إعادة محاولة وبسجلّ صادق',
    generatorState.aborted === true && (generatorState.afterAbort || 0) === 0 && host.state.streamCalls === 1 &&
      log.json?.totals?.calls === 1 && first.code === 'CLIENT_GONE' && first.ok === false,
    `streamAborted=${generatorState.aborted === true} · chunksAfterAbort=${generatorState.afterAbort || 0}/${generatorState.yielded || 0} · streamCalls=${host.state.streamCalls} · logCalls=${log.json?.totals?.calls} · code=${first.code ?? 'null'} · ok=${first.ok ?? 'null'} · chunksAfterSocketDeath=${generatorState.afterDestroy || 0}`)
}

/* H4b — the same walk-away, but BEFORE the first token: no second paid call. --------------
   An independent verification removed the abort check inside the message-shape loop and this
   gate still passed (8/8) — the fixture above cannot reach it, because chunks arrive first and
   the first shape comes back non-empty. So the shape guard gets its own fixture: the client
   leaves while the model has produced nothing yet, and the difference is one whole extra call. */
{
  for (const key of Object.keys(generatorState)) delete generatorState[key]
  const host = fakeHost({ stream: lateStream() })
  handlerRef = mount(host)
  const handOff = (request) => { setTimeout(() => request.destroy(), 60) }
  await postRequest(ROUTE + '/translate', { segments: ['a reply whose first token arrives after the client left'], target: 'ar' }, { handOff })
  await sleep(900)
  const log = await getRequest(ROUTE + '/log')
  const first = (log.json?.calls ?? [])[0] || {}
  check('H4b · الإلغاء قبل أول قطعة ⇒ لا نداء ثانٍ لشكل الرسالة (توكنات محفوظة)',
    host.state.streamCalls === 1 && log.json?.totals?.calls === 1 && first.code === 'CLIENT_GONE',
    `streamCalls=${host.state.streamCalls} · logCalls=${log.json?.totals?.calls} · code=${first.code ?? 'null'} · aborted=${generatorState.aborted === true} · chunks=${generatorState.yielded || 0}`)
}

/* H5 — the optional skill service must not be able to kill the fiber. ------------------ */
{
  const registrations = []
  const fakeSkills = { register (definition) { registrations.push(definition); return () => {} } }
  process.env.DCT_AGENT_SKILL = '1'
  let threw = null
  let state5 = null
  try {
    const host = fakeHost({ stream: batchStream(), skills: fakeSkills, skillsThrows: true })
    state5 = host.state
    handlerRef = mount(host)
  } catch (error) {
    threw = String(error?.message ?? error)
  } finally {
    delete process.env.DCT_AGENT_SKILL
  }
  const reg = registrations[0] || null
  check('H5 · DCT_AGENT_SKILL=1 مع خدمة غير مُعلَنة ⇒ المحرّك حيّ والسكيل يُسجَّل بعقد الخدمة',
    threw === null && state5?.routes?.length === 1 && registrations.length === 1 &&
      typeof reg?.content === 'string' && reg.content.length > 400 && reg.source === 'runtime' && !('body' in (reg || {})),
    `threw=${threw ?? 'null'} · routes=${state5?.routes?.length ?? 'null'} · registrations=${registrations.length} · content=${typeof reg?.content}/${reg?.content?.length ?? 0} · source=${String(reg?.source)} · hasBody=${reg ? ('body' in reg) : 'null'}`)
}

/* H6 — the declared inject shape is the one this cordis actually honours. -------------- */
check('H6 · inject مصفوفة بالخدمات الثلاث (الشكل المقيس ACTIVE)',
  Array.isArray(inject) && inject.length === 3 && inject.includes('webServer') && inject.includes('llm') && inject.includes('agentDefaultModel'),
  `Array.isArray=${Array.isArray(inject)} · inject=[${Array.isArray(inject) ? inject.join(', ') : JSON.stringify(inject)}]`)

/* H7 — the same fix on the REAL framework and the REAL skill service (when present). --- */
{
  const NM = join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules')
  const skillPkg = join(NM, '@deepseek-ai', 'dsh-skill', 'lib', 'index.js')
  const cordisPkg = join(NM, '@deepseek-ai', 'cordis', 'lib', 'index.js')
  const present = (p) => { try { readFileSync(p); return true } catch { return false } }
  if (!present(skillPkg) || !present(cordisPkg)) {
    console.log(`[SKIP] H7 · إطار cordis المشحون غير موجود في ${NM} — الفحص على الإطار الحقيقي لم يُشغَّل (سبب ظاهر، لا تخطٍّ صامت)`)
  } else {
    const { Context } = await import(pathToFileURL(cordisPkg).href)
    const skillNs = await import(pathToFileURL(skillPkg).href)
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const STATE = { 0: 'PENDING', 1: 'LOADING', 2: 'ACTIVE', 3: 'FAILED', 4: 'DISPOSED', 5: 'UNLOADING' }
    const stateOf = async (fiber, ms = 900) => { const t0 = Date.now(); while (Date.now() - t0 < ms && (fiber.state === 0 || fiber.state === 1)) await wait(20); return STATE[fiber.state] ?? String(fiber.state) }
    process.env.DCT_AGENT_SKILL = '1'
    const root = new Context()
    const fSkill = root.plugin(skillNs.default)
    await stateOf(fSkill)
    const routes = []
    const disposers = [
      root.provide('webServer', { register (r) { routes.push(r); return () => {} } }),
      root.provide('llm', { stream: async function * () { yield { type: 'finish', reason: 'stop' } }, resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }], defaultEffort: 'high' } }) }),
      root.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'fake', model: 'fake' }) })
    ]
    const ns = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href + '?live=' + Date.now())
    let fiber = null
    let error = null
    try { fiber = root.plugin(ns) } catch (e) { error = String(e?.message ?? e) }
    const state7 = fiber ? await stateOf(fiber) : null
    let loaded = null
    let loadError = null
    try {
      const def = await root.skills.get('translate-this', { cwd: ROOT })
      loaded = def ? { contentType: typeof def.content, contentLength: def.content.length, source: def.source } : null
    } catch (e) { loadError = String(e?.message ?? e) }
    delete process.env.DCT_AGENT_SKILL
    check('H7 · إطار cordis الحقيقي: DCT_AGENT_SKILL=1 ⇒ ACTIVE + مسار + سكيل تُحمَّل فعلًا',
      error === null && state7 === 'ACTIVE' && routes.length === 1 && !!loaded && loaded.contentType === 'string' && loaded.contentLength > 400,
      `fiberState=${state7 ?? 'null'} · error=${error ?? 'null'} · routes=${routes.length} · skillGet=${loaded ? JSON.stringify(loaded) : 'null'} · getError=${loadError ?? 'null'}`)
    try { await fiber?.dispose() } catch {}
    try { await fSkill.dispose() } catch {}
    for (const d of disposers.reverse()) { try { await d() } catch {} }
  }
}

/* ------------------------------------------------------------------------- verdict --- */
const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} host checks passed  ${failed ? '· HOST GATE CLOSED' : '· HOST GATE OPEN'}`)
if (VERBOSE) console.log(JSON.stringify(results, null, 2))
server.close()
process.exit(failed ? 1 : 0)
