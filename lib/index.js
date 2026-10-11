/**
 * dsh-translate-this — host half.
 *
 * 0.6: the engine. The browser half never talks to a model — it posts text here, and this
 * half calls the model the user already configured (`ctx.llm.stream`, decision D5). No
 * external translation service, no second key, no weights to download: the same provider
 * and the same trust boundary as the user's own conversation.
 *
 * 0.6 part two, the four things this file now owns (PLAN.md §8):
 *   - **Batches.** N segments travel in ONE call behind an explicit, numbered separator,
 *     with an input ceiling and a computed output ceiling.
 *   - **Alignment is a contract.** The markers must come back verbatim, in order, one per
 *     segment. Any deviation — a missing marker, a reordered one, one that leaked into a
 *     translated segment, an empty segment, a truncated reply — throws the WHOLE batch away:
 *     `ALIGNMENT_FAILED`, nothing returned to the client, therefore nothing cached. A
 *     half-aligned batch is worse than no translation, because it would be stored under a
 *     key that promises the segments mean what they meant on the way in.
 *   - **One retry, and only where a retry can help.** A transport failure, a rate limit, a
 *     truncated reply or a misaligned one get exactly one more attempt after a short pause.
 *     A missing model or a missing credential does not — retrying those only spends time.
 *   - **Metadata-only call log.** Hash-free, text-free: segments, characters, model,
 *     milliseconds, usage numbers, outcome code. Readable at `GET /log`. The raw text never
 *     enters a log, a metric or an error message.
 *
 * Three rules this file exists to honour:
 *   - **Never log the text.** The route logs metadata only (characters, model, milliseconds),
 *     because a raw-text log is a new secret store and this project threw that idea out.
 *   - **No silent fallback.** A missing model, a bad credential, a timeout or a transport
 *     failure comes back as a named code, and the panel shows it with a red line. The client
 *     never quietly switches to another service.
 *   - **Same-origin only.** The route refuses a cross-origin `Origin` header, so a page the
 *     user happens to visit cannot spend their tokens through it.
 *
 * No `@deepseek-ai/*` import: the runtime is a peer, and services are read through `ctx` /
 * `ctx.get(...)` so a host without one of them degrades visibly instead of crashing.
 */

export const name = 'dsh-translate-this'

/**
 * The webserver is where the engine lives, and the model services are what it calls. All
 * three are declared, because cordis refuses to hand a service that was not injected
 * (`cannot get property "llm" without inject` — measured, not guessed). A host missing one
 * of them leaves the plugin unmounted, which is visible in the plugin list; that is the
 * failure mode this project prefers over mounting and misbehaving.
 */
export const inject = ['webServer', 'llm', 'agentDefaultModel']

const ROUTE = '/dsh-translate-this'
const MAX_TEXT = 4000            // one segment's ceiling (unchanged from 0.6 part one)
const MAX_SEGMENTS = 16          // segments per call: the batch ceiling the client must respect
const MAX_BATCH_CHARS = 3000     // input ceiling per call
const TIMEOUT_MS = 45000         // per attempt, not per batch
const RETRY_DELAY_MS = 400       // one retry, after a short pause
const LOG_KEEP = 60              // call-log ring size (host memory only, never written to disk)

/**
 * The batch protocol's version. It rides in the client's cache key, so changing the prompt
 * or the separator invalidates stored translations instead of silently reusing text that
 * was produced under different instructions (PLAN.md §6.2).
 */
const PROMPT_VERSION = 'batch-v1'

const LANGUAGES = { ar: 'Arabic', en: 'English', fr: 'French', zh: 'Chinese', tr: 'Turkish' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------------ the protocol --- */

/**
 * The separator: rare in prose, explicit, and numbered so order is checkable rather than
 * assumed. It is deliberately NOT something a model would translate (it is punctuation and
 * ASCII), and it is never allowed to survive into a translated segment.
 */
const markerFor = (i) => '<<<DCT:' + i + '>>>'
const MARKER_RE = /<<<DCT:(\d+)>>>/g
const MARKER_ANY = /<<<DCT/i

/** Render the numbered batch payload the model receives. Exported for the protocol gate. */
export function buildBatchContent(segments) {
  return segments.map((s, i) => markerFor(i + 1) + '\n' + s).join('\n')
}

/**
 * Parse a batch reply and prove the alignment before anything is trusted.
 *
 * Every rejection below is a real way alignment dies, and each one is named so a failure in
 * the panel says WHICH contract broke — a count, an order, a leaked marker, an empty slot —
 * instead of "the model was weird". Exported so `acceptance/protocol.mjs` can feed it
 * deliberately broken replies and watch it refuse them.
 *
 * @param reply - the model's raw text for the whole batch.
 * @param count - how many segments were sent.
 * @returns `{ ok: true, segments }` or `{ ok: false, code, detail }` (detail is metadata: numbers and slot indexes only, never text).
 */
export function parseBatchReply(reply, count) {
  const text = String(reply ?? '')
  const found = []
  MARKER_RE.lastIndex = 0
  for (let m = MARKER_RE.exec(text); m !== null; m = MARKER_RE.exec(text)) {
    found.push({ n: Number(m[1]), start: m.index, end: MARKER_RE.lastIndex })
  }
  if (found.length !== count) {
    return { ok: false, code: 'ALIGNMENT_FAILED', detail: 'markers ' + found.length + '/' + count }
  }
  for (let i = 0; i < found.length; i += 1) {
    if (found[i].n !== i + 1) {
      return { ok: false, code: 'ALIGNMENT_FAILED', detail: 'slot ' + (i + 1) + ' carries marker ' + found[i].n }
    }
  }
  if (text.slice(0, found[0].start).trim() !== '') {
    return { ok: false, code: 'ALIGNMENT_FAILED', detail: 'text before the first marker' }
  }
  const segments = []
  for (let i = 0; i < found.length; i += 1) {
    const end = i + 1 < found.length ? found[i + 1].start : text.length
    const body = text.slice(found[i].end, end)
    if (MARKER_ANY.test(body)) {
      return { ok: false, code: 'ALIGNMENT_FAILED', detail: 'marker text inside segment ' + (i + 1) }
    }
    const clean = body.replace(/^\s+/, '').replace(/\s+$/, '')
    if (clean === '') {
      return { ok: false, code: 'ALIGNMENT_FAILED', detail: 'segment ' + (i + 1) + ' came back empty' }
    }
    segments.push(clean)
  }
  return { ok: true, segments }
}

/**
 * A batch gets an output ceiling derived from its input, because one fixed ceiling is wrong
 * in both directions: too small truncates a long batch (and a truncated batch fails
 * alignment, wasting the call), too large lets one runaway reply burn the budget. The
 * estimate is deliberately generous — Arabic from English is roughly character-for-character
 * and denser in tokens — and `finish: max-tokens` is treated as a failure, so an under-
 * estimate shows up as a visible `TRUNCATED` instead of a silently clipped translation.
 */
export function maxTokensFor(chars) {
  return Math.max(512, Math.min(4096, 256 + Math.ceil(chars / 2)))
}

/**
 * The engine's manner, per target language. Short and about translation only: no tools, no
 * conversation, no "explain", no commentary. Code, paths, commands, URLs, numbers and
 * placeholders must survive byte-for-byte — that is the measured promise this project made
 * (§7). The target arrives with each request, so one host can serve several readers.
 *
 * `batch` adds the separator contract. It is a separate variant on purpose: a single
 * segment keeps the exact prompt that was measured working in 0.6 part one, and only a real
 * batch pays for the marker rules.
 */
const systemFor = (target, batch) => [
  'You translate user-interface text for a developer tool into ' + (LANGUAGES[target] || LANGUAGES.ar) + '.',
  'Rules:',
  '1. Output ONLY the translation. No quotes, no notes, no explanation, no alternatives.',
  '2. Keep code, identifiers, file paths, shell commands, URLs, versions, numbers and',
  '   {placeholders} exactly as they are — never translate them, never reformat them.',
  '3. Keep the original line breaks, bullet markers and leading/trailing whitespace.',
  '4. Use fluent, professional prose in the target language. Never transliterate Latin words.',
  '5. If the text is already in the target language, return it unchanged.'
].concat(batch ? [
  '6. The input holds several segments. Each segment starts on its own line with a marker',
  '   of the exact form <<<DCT:n>>> where n is its number, and the segments are numbered',
  '   1, 2, 3 … in order.',
  '7. Output every segment, in the same order, each on its own line preceded by its OWN',
  '   marker, copied character for character: <<<DCT:1>>>, then the translation of segment 1,',
  '   then <<<DCT:2>>>, and so on.',
  '8. Never merge two segments, never split one, never reorder them, never add or drop a',
  '   marker, and never translate or modify a marker. No text before the first marker and',
  '   no text after the last segment.'
] : []).join('\n')

const send = (res, status, body) => {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

const readJson = (req, limit = 262144) => new Promise((resolve) => {
  const chunks = []
  let size = 0
  req.on('data', (c) => { size += c.length; if (size > limit) { req.destroy(); return } chunks.push(c) })
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8').trim()
    if (raw === '') return resolve({})
    try { resolve(JSON.parse(raw)) } catch { resolve({}) }
  })
  req.on('error', () => resolve({}))
})

/** Same-origin guard: a browser cross-origin POST always carries Origin. */
const sameOrigin = (req) => {
  const origin = req.headers?.origin
  if (!origin) return true                       // local scripts and curl carry none
  try {
    const o = new URL(origin)
    const host = String(req.headers?.host ?? '')
    return o.host === host && (o.protocol === 'http:' || o.protocol === 'https:')
  } catch { return false }
}

/**
 * Which failures are worth one more attempt. A misalignment and a truncation are the two
 * this version is built around: both are often just an unlucky sampling, and both are
 * cheap to detect before anything is stored. A missing model, a rejected key or a bad
 * request are permanent — retrying them only makes the user wait longer for the same answer.
 */
const RETRYABLE = new Set(['ALIGNMENT_FAILED', 'TRUNCATED', 'TRANSPORT', 'TIMEOUT', 'ABORTED', 'EMPTY_REPLY', 'RATE_LIMIT'])
const retryable = (error) => RETRYABLE.has(String(error?.code || error?.name || ''))

/**
 * Mount the host half.
 * @param ctx - host context (cordis).
 */
export function apply(ctx) {
  const webServer = ctx.webServer ?? ctx.get?.('webServer')
  const llm = ctx.llm ?? ctx.get?.('llm')
  const modelService = ctx.agentDefaultModel ?? ctx.get?.('agentDefaultModel')

  ctx.logger?.info?.('[dsh-translate-this] 0.6 host half mounted — engine route ' + ROUTE)

  /** The call log: metadata only, host memory only, never the text. */
  const callLog = []
  const totals = {
    calls: 0, ok: 0, failed: 0, retried: 0, alignmentFailures: 0,
    segments: 0, chars: 0, inputTokens: 0, outputTokens: 0, callsWithoutUsage: 0
  }

  const note = (entry) => {
    callLog.push(entry)
    if (callLog.length > LOG_KEEP) callLog.shift()
    totals.calls += 1
    if (entry.ok) totals.ok += 1; else totals.failed += 1
    if (entry.attempts > 1) totals.retried += 1
    if (entry.code === 'ALIGNMENT_FAILED') totals.alignmentFailures += 1
    totals.segments += entry.segments || 0
    totals.chars += entry.chars || 0
    if (entry.usage) {
      totals.inputTokens += Number(entry.usage.inputTokens) || 0
      totals.outputTokens += Number(entry.usage.outputTokens) || 0
    } else {
      totals.callsWithoutUsage += 1
    }
  }

  const pickModel = () => {
    try {
      const selected = typeof modelService?.currentSelection === 'function' ? modelService.currentSelection() : null
      if (selected?.provider && selected?.model) return { provider: selected.provider, model: selected.model }
    } catch { /* fall through to "unavailable" */ }
    return null
  }

  /**
   * One model call, plus the honest record of what the stream actually carried.
   *
   * The `diag` block is a measurement, not decoration: this project twice paid for guessing
   * the chunk shape (a plain-string message streamed a single `finish` and nothing else —
   * §11, ح-10/ح-11). So the route reports the chunk TYPES it saw, the field NAMES those
   * chunks carried, the usage object as it arrived, and the finish reason — all metadata,
   * no text — and the cost counter is built on what came back rather than on what the type
   * definitions promise.
   */
  const callModel = async ({ content, signal, target, batch }) => {
    const selected = pickModel()
    if (typeof llm?.stream !== 'function') {
      const error = new Error('this host exposes no llm service')
      error.code = 'NO_ADAPTER'
      throw error
    }
    if (!selected) {
      const error = new Error('no default model is selected')
      error.code = 'NO_MODEL'
      throw error
    }
    const call = {
      provider: selected.provider,
      model: selected.model,
      system: systemFor(target, batch),
      maxTokens: maxTokensFor(content.length),
      purpose: 'dsh-translate-this',
      signal
    }
    const run = async (payload) => {
      let out = ''
      const seen = []
      const types = []
      const keys = []
      let usage = null
      let usageKeys = []
      let finish = 'none'
      const stream = await llm.stream({ ...call, messages: [{ role: 'user', content: payload }] })
      for await (const chunk of stream) {
        // Tolerant on the way in, and honest on the way out: whatever shape arrives, its TYPE
        // is recorded so an empty reply can say which chunks it actually got instead of
        // returning the source text as if it were a translation.
        const type = chunk?.type || (chunk && chunk.constructor && chunk.constructor.name) || typeof chunk
        if (seen.length < 8 && !seen.includes(type)) seen.push(type)
        if (!types.includes(type)) types.push(type)
        if (chunk && typeof chunk === 'object') {
          for (const k of Object.keys(chunk)) if (!keys.includes(k)) keys.push(k)
        }
        if (type === 'usage') {
          if (chunk.usage && typeof chunk.usage === 'object') {
            usage = chunk.usage
            usageKeys = Object.keys(chunk.usage)
          }
        }
        if (type === 'finish' || type === 'done' || type === 'end') {
          const kind = chunk?.reason?.kind || chunk?.reason || type
          finish = typeof kind === 'string' ? kind : String(kind?.kind || 'finish')
          break
        }
        if (typeof chunk?.text === 'string' && (type === 'text-delta' || type === 'text' || type === 'delta' || !chunk.type)) out += chunk.text
        else if (typeof chunk?.delta === 'string') out += chunk.delta
      }
      return { out, seen, types, keys, usage, usageKeys, finish, model: selected.provider + '/' + selected.model }
    }
    // Two message shapes exist in the wild, and an empty answer is how the wrong one shows
    // itself (measured: a plain-string `content` streamed a single `finish` chunk and no
    // text). So: the typed parts form first, the plain form second, and the shape that
    // actually worked is reported back instead of being assumed.
    const shapes = [
      { name: 'parts', content: [{ type: 'text', text: content }] },
      { name: 'string', content }
    ]
    let out = null
    let last = null
    for (const shape of shapes) {
      try {
        const attempt = await run(shape.content)
        last = attempt
        if (String(attempt.out ?? '').trim() !== '') { out = { ...attempt, shape: shape.name }; break }
      } catch (error) {
        last = { out: '', seen: [], types: [], keys: [], finish: 'error', error: String(error?.message ?? error) }
        if (!/content|message|shape|invalid/i.test(String(error?.message ?? ''))) throw error
      }
    }
    if (!out) {
      const error = new Error('the model returned no text (chunks seen: ' + ((last && last.seen.join(', ')) || 'none') + ')')
      error.code = 'EMPTY_REPLY'
      throw error
    }
    const diag = { types: out.types, keys: out.keys, usageKeys: out.usageKeys, finish: out.finish, shape: out.shape }
    return { text: String(out.out), usage: out.usage, diag, model: out.model }
  }

  /**
   * One attempt at the whole request. A single segment keeps the path measured in 0.6 part
   * one; two or more segments are batch mode and must pass the alignment contract before
   * their text is returned at all.
   */
  const translateOnce = async (segments, signal, target) => {
    const batch = segments.length > 1
    const content = batch ? buildBatchContent(segments) : segments[0]
    const out = await callModel({ content, signal, target, batch })
    if (String(out.diag.finish) === 'max-tokens') {
      const error = new Error('the reply hit the token ceiling after ' + out.text.length + ' characters — nothing stored')
      error.code = 'TRUNCATED'
      error.diag = out.diag
      throw error
    }
    if (!batch) return { segments: [out.text], usage: out.usage, diag: out.diag, model: out.model }
    const parsed = parseBatchReply(out.text, segments.length)
    if (!parsed.ok) {
      const error = new Error('batch alignment failed (' + parsed.detail + ') — the whole batch is dropped, nothing stored')
      error.code = parsed.code
      error.diag = { ...out.diag, alignment: parsed.detail }
      throw error
    }
    return { segments: parsed.segments, usage: out.usage, diag: out.diag, model: out.model }
  }

  if (!webServer?.register) {
    ctx.logger?.warn?.('[dsh-translate-this] no webServer service in this host — the engine route is unavailable, and the panel will say so')
    return
  }

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: async (req, res) => {
      if (!sameOrigin(req)) return send(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'cross-origin request rejected' } })
      const url = new URL(req.url ?? '/', 'http://dsh.local')
      const path = url.pathname
      const method = (req.method ?? 'GET').toUpperCase()

      if (method === 'GET' && path === ROUTE + '/status') {
        const selected = pickModel()
        return send(res, 200, {
          ok: true,
          engine: typeof llm?.stream === 'function' ? 'host' : 'unavailable',
          model: selected ? selected.provider + '/' + selected.model : null,
          promptVersion: PROMPT_VERSION,
          ceilings: { maxSegments: MAX_SEGMENTS, maxBatchChars: MAX_BATCH_CHARS, maxText: MAX_TEXT }
        })
      }

      // The call log: metadata only, so it is safe to read from the panel and to quote in a
      // bug report. No text ever reaches this array, which is why it can be this open.
      if (method === 'GET' && path === ROUTE + '/log') {
        const limit = Math.max(1, Math.min(LOG_KEEP, Number(url.searchParams.get('limit')) || 20))
        return send(res, 200, {
          ok: true,
          promptVersion: PROMPT_VERSION,
          totals,
          calls: callLog.slice(-limit).reverse()
        })
      }

      if (method === 'POST' && path === ROUTE + '/translate') {
        const body = await readJson(req)
        const target = typeof body?.target === 'string' ? body.target : 'ar'
        const list = Array.isArray(body?.segments) ? body.segments.filter((s) => typeof s === 'string') : null
        const segments = list && list.length ? list : (typeof body?.text === 'string' ? [body.text] : [])
        if (!segments.length || segments.every((s) => s.trim() === '')) {
          return send(res, 400, { ok: false, error: { code: 'EMPTY', message: 'no text to translate' } })
        }
        if (segments.length > MAX_SEGMENTS) {
          return send(res, 413, { ok: false, error: { code: 'TOO_MANY_SEGMENTS', message: segments.length + ' segments in one call, ceiling is ' + MAX_SEGMENTS } })
        }
        const chars = segments.reduce((a, s) => a + s.length, 0)
        if (chars > MAX_BATCH_CHARS) {
          return send(res, 413, { ok: false, error: { code: 'BATCH_TOO_LONG', message: chars + ' characters in one call, ceiling is ' + MAX_BATCH_CHARS } })
        }
        if (segments.some((s) => s.length > MAX_TEXT)) {
          return send(res, 413, { ok: false, error: { code: 'TEXT_TOO_LONG', message: 'a segment exceeds ' + MAX_TEXT + ' characters' } })
        }

        const started = Date.now()
        let attempts = 0
        let result = null
        let lastError = null
        let firstCode = null
        while (attempts < 2 && !result) {
          attempts += 1
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
          try {
            result = await translateOnce(segments, controller.signal, target)
          } catch (error) {
            lastError = error
            // "two attempts" is not a measurement until it says WHY the first one was thrown
            // away (measured live: one call took 5.1 s over two attempts and the log could not
            // say what the first attempt had done wrong).
            if (attempts === 1) firstCode = String(error?.code || error?.name || 'TRANSPORT')
            if (attempts >= 2 || !retryable(error)) break
            await sleep(RETRY_DELAY_MS)
          } finally {
            clearTimeout(timer)
          }
        }

        const ms = Date.now() - started
        if (result) {
          // Metadata only: never the text itself.
          ctx.logger?.debug?.(`[dsh-translate-this] translated ${segments.length} segment(s)/${chars} chars via ${result.model} in ${ms}ms`)
          note({ at: new Date().toISOString(), mode: segments.length > 1 ? 'batch' : 'single', segments: segments.length, chars, target, model: result.model, ms, attempts, firstCode, ok: true, code: null, usage: result.usage, finish: result.diag.finish, shape: result.diag.shape })
          return send(res, 200, {
            ok: true,
            segments: result.segments,
            text: result.segments.length === 1 ? result.segments[0] : undefined,
            model: result.model,
            usage: result.usage,
            diag: result.diag,
            attempts,
            firstCode,
            ms
          })
        }

        const code = String(lastError?.code || lastError?.name || 'TRANSPORT')
        const diag = lastError?.diag || null
        ctx.logger?.warn?.(`[dsh-translate-this] engine failed (${code}) after ${ms}ms, ${attempts} attempt(s)`)
        note({ at: new Date().toISOString(), mode: segments.length > 1 ? 'batch' : 'single', segments: segments.length, chars, target, model: null, ms, attempts, ok: false, code, usage: null, finish: diag ? diag.finish : null, shape: diag ? diag.shape : null, alignment: diag ? diag.alignment : undefined })
        return send(res, 502, { ok: false, error: { code, message: String(lastError?.message ?? lastError) }, attempts, ms, diag })
      }

      return send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'unknown route' } })
    }
  }), 'dsh-translate-this: engine route')
}
