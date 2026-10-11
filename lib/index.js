/**
 * dsh-translate-this — host half.
 *
 * What this half does in 0.5: nothing but exist, and say so. That is deliberate,
 * not unfinished:
 *
 *   - The layer that had to survive the acceptance gate is the **DOM injector**,
 *     and it lives entirely in the browser half (`./client`). PLAN.md §5: the code
 *     that survives `acceptance/index.html` is what moves into the plugin — not the
 *     other way round.
 *   - 0.5 ships "a fixed engine, no model, no network" (§8). So there is no engine
 *     call here yet, and no host store either.
 *   - The one job this file takes on in 0.6 is the engine: `ctx.llm.stream` with the
 *     user's own provider/model (decision D5), batched with an explicit separator,
 *     alignment failure thrown away rather than cached, and a metadata-only call log
 *     (hash + length + model + time — never the raw text).
 *
 * No `@deepseek-ai/*` import, by decision: the runtime is a peer, not a dependency,
 * and no upstream abstraction is extended.
 */

/** Plugin name as the loader row sees it. */
export const name = 'dsh-translate-this'

/**
 * No host services are injected yet. 0.6 will ask for the model service; asking for
 * it now would mount a plugin that reaches for a capability it does not use.
 */
export const inject = []

/**
 * Mount the host half.
 * @param ctx - host context (cordis).
 */
export function apply(ctx) {
  ctx.logger?.info?.(
    '[dsh-translate-this] 0.5.0 host half mounted — engine seam only. ' +
    'The browser half does the work; the model call (ctx.llm.stream) is 0.6 by decision D5.'
  )
}
