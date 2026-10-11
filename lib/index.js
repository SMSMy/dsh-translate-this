/**
 * dsh-translate-this — host half.
 *
 * 0.6: the engine. The browser half never talks to a model — it posts text here, and this
 * half calls the model the user already configured (`ctx.llm.stream`, decision D5). No
 * external translation service, no second key, no weights to download: the same provider
 * and the same trust boundary as the user's own conversation.
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
const MAX_TEXT = 4000
const TIMEOUT_MS = 45000

/**
 * The engine's manner. Short, kept in the package for review, and deliberately about
 * translation only: no tools, no conversation, no "explain", no commentary. Code, paths,
 * commands, URLs, numbers and placeholders must survive byte-for-byte — that is the
 * measured promise this project made (§7).
 */
const SYSTEM_PROMPT = [
  'You translate user-interface text for a developer tool from English into Arabic.',
  'Rules:',
  '1. Output ONLY the translation. No quotes, no notes, no explanation, no alternatives.',
  '2. Keep code, identifiers, file paths, shell commands, URLs, versions, numbers and',
  '   {placeholders} exactly as they are — never translate them, never reformat them.',
  '3. Keep the original line breaks, bullet markers and leading/trailing whitespace.',
  '4. Use fluent, professional Modern Standard Arabic. Never transliterate Latin words.',
  '5. If the text is already Arabic, return it unchanged.'
].join('\n')

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
 * Mount the host half.
 * @param ctx - host context (cordis).
 */
export function apply(ctx) {
  const webServer = ctx.webServer ?? ctx.get?.('webServer')
  const llm = ctx.llm ?? ctx.get?.('llm')
  const modelService = ctx.agentDefaultModel ?? ctx.get?.('agentDefaultModel')

  ctx.logger?.info?.('[dsh-translate-this] 0.6 host half mounted — engine route ' + ROUTE)

  const pickModel = () => {
    try {
      const selected = typeof modelService?.currentSelection === 'function' ? modelService.currentSelection() : null
      if (selected?.provider && selected?.model) return { provider: selected.provider, model: selected.model }
    } catch { /* fall through to "unavailable" */ }
    return null
  }

  /**
   * One translation. The message shape is tried in the plain form first and, only if the
   * service rejects it, in the parts form — a shape guess that stays measured: the second
   * attempt happens because the first answered with an error, never because we hoped.
   */
  const translateOnce = async (text, signal) => {
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
      system: SYSTEM_PROMPT,
      maxTokens: 2048,
      purpose: 'dsh-translate-this',
      signal
    }
    const run = async (content) => {
      let out = ''
      const seen = []
      const stream = await llm.stream({ ...call, messages: [{ role: 'user', content }] })
      for await (const chunk of stream) {
        // Tolerant on the way in, and honest on the way out: whatever shape arrives, its TYPE
        // is recorded so an empty reply can say which chunks it actually got instead of
        // returning the source text as if it were a translation.
        const type = chunk?.type || (chunk && chunk.constructor && chunk.constructor.name) || typeof chunk
        if (seen.length < 8 && !seen.includes(type)) seen.push(type)
        if (typeof chunk?.text === 'string' && (type === 'text-delta' || type === 'text' || type === 'delta' || !chunk.type)) out += chunk.text
        else if (typeof chunk?.delta === 'string' && type !== 'finish') out += chunk.delta
        else if (type === 'finish' || type === 'done' || type === 'end') break
      }
      return { out, seen }
    }
    // Two message shapes exist in the wild, and an empty answer is how the wrong one shows
    // itself (measured: a plain-string `content` streamed a single `finish` chunk and no
    // text). So: the typed parts form first, the plain form second, and the shape that
    // actually worked is reported back instead of being assumed.
    const shapes = [
      { name: 'parts', content: [{ type: 'text', text }] },
      { name: 'string', content: text }
    ]
    let out = null
    let last = null
    for (const shape of shapes) {
      try {
        const attempt = await run(shape.content)
        last = attempt
        if (String(attempt.out ?? '').trim() !== '') { out = { ...attempt, shape: shape.name }; break }
      } catch (error) {
        last = { out: '', seen: [], error: String(error?.message ?? error) }
        if (!/content|message|shape|invalid/i.test(String(error?.message ?? ''))) throw error
      }
    }
    if (!out) {
      const error = new Error('the model returned no text (chunks seen: ' + ((last && last.seen.join(', ')) || 'none') + ')')
      error.code = 'EMPTY_REPLY'
      throw error
    }
    return { text: String(out.out), model: selected.provider + '/' + selected.model, shape: out.shape }
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
          model: selected ? selected.provider + '/' + selected.model : null
        })
      }

      if (method === 'POST' && path === ROUTE + '/translate') {
        const body = await readJson(req)
        const text = typeof body?.text === 'string' ? body.text : ''
        if (text.trim() === '') return send(res, 400, { ok: false, error: { code: 'EMPTY', message: 'no text to translate' } })
        if (text.length > MAX_TEXT) return send(res, 413, { ok: false, error: { code: 'TEXT_TOO_LONG', message: 'text exceeds ' + MAX_TEXT + ' characters' } })

        const started = Date.now()
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
        try {
          const result = await translateOnce(text, controller.signal)
          // Metadata only: never the text itself.
          ctx.logger?.debug?.(`[dsh-translate-this] translated ${text.length} chars via ${result.model} in ${Date.now() - started}ms`)
          return send(res, 200, { ok: true, text: result.text, model: result.model })
        } catch (error) {
          const code = String(error?.code || error?.name || 'TRANSPORT')
          ctx.logger?.warn?.(`[dsh-translate-this] engine failed (${code}) after ${Date.now() - started}ms`)
          return send(res, 502, { ok: false, error: { code, message: String(error?.message ?? error) } })
        } finally {
          clearTimeout(timer)
        }
      }

      return send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'unknown route' } })
    }
  }), 'dsh-translate-this: engine route')
}
