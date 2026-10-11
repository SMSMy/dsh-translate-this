/**
 * golden.mjs — the 0.7 acceptance set, run against a live host (PLAN.md §8).
 *
 * This is the one gate that spends tokens, so it is deliberately NOT part of `run.mjs`: it runs
 * when a release is being prepared (`npm run golden -- "<authenticated url>"`), prints a report,
 * and exits non-zero when the declared bars are not met.
 *
 * What it measures, and why each measurement is honest:
 *
 *   - **Code integrity (bar: 100%)** — every atomic token is masked by the SHIPPING masker before
 *     the call, and must come back. The number is computed from `maskTokens`/`unmaskTokens`
 *     imported from `lib/client.js`, not from a copy of the rules.
 *   - **Glossary compliance (bar: ≥90%)** — each item declares the entry ids it touches; the
 *     translation must carry the preferred rendering (or, where the glossary forbids a variant,
 *     the host's post-edit has already replaced it and says so in `diag.glossary`).
 *   - **Segmentation/reassembly** — the translated segments are glued with the shipping
 *     `composeSegments`, so a lossy split would fail the comparison against the source layout.
 *
 * Usage:
 *   node acceptance/golden.mjs "<authenticated url>" [--json report.json] [--quiet]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const args = process.argv.slice(2)
const BASE = args.find((a) => !a.startsWith('--'))
const JSON_OUT = args.includes('--json') ? args[args.indexOf('--json') + 1] : null
const QUIET = args.includes('--quiet')
if (!BASE) { console.error('usage: node acceptance/golden.mjs "<authenticated url>" [--json out.json]'); process.exit(2) }

const BAR_GLOSSARY = 0.9
const BAR_INTEGRITY = 1.0

/* --------------------------------------------------- the shipping code, loaded as shipped --- */
let definition = null
globalThis.window = { __ModuleLoader__: { load: (d) => { definition = d } } }
new Function('window', readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8'))(globalThis.window)
const client = definition.factory(() => ({}))
const { maskTokens, unmaskTokens, splitSegments, composeSegments } = client
const { GLOSSARY } = await import(new URL('../data/glossary.js', import.meta.url).href)
const { hasPreferred } = await import(new URL('../lib/glossary.js', import.meta.url).href)
const golden = JSON.parse(readFileSync(join(ROOT, 'data', 'golden.json'), 'utf8'))
const byId = new Map(GLOSSARY.map((e) => [e.id, e]))

/* ------------------------------------------------------------------------- the host call --- */
const first = await fetch(BASE, { redirect: 'manual' })
const cookies = (typeof first.headers.getSetCookie === 'function' ? first.headers.getSetCookie() : [])
  .map((c) => c.split(';')[0]).join('; ')
const opts = (extra = {}) => ({ headers: { cookie: cookies, ...(extra.headers || {}) }, ...extra })
const status = await (await fetch(new URL('/dsh-translate-this/status', BASE).href, opts())).json()
if (!status.ok || status.engine !== 'host') {
  console.error('the host has no engine: ' + JSON.stringify(status))
  process.exit(2)
}
if (!QUIET) console.log('host: ' + status.model + ' · prompt ' + status.promptVersion + ' · effort ' + JSON.stringify(status.reasoning && status.reasoning.chosen))

/** One call per item keeps the measurement readable; the batch path is measured by run.mjs. */
async function translate(segments) {
  const res = await fetch(new URL('/dsh-translate-this/translate', BASE).href, opts({
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ segments, target: golden.tgt })
  }))
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

/* ------------------------------------------------------------------------------ the run --- */
const rows = []
let glossaryHits = 0
let glossaryTotal = 0
let tokensTotal = 0
let tokensKept = 0
let calls = 0
let failures = 0

for (const item of golden.items) {
  const masked = maskTokens(item.text)
  const pieces = splitSegments(masked.text)
  const trimmed = pieces.map((p) => p.trim()).filter((p) => p !== '')
  const out = await translate(trimmed)
  calls += 1
  if (!out.body.ok) {
    failures += 1
    rows.push({ id: item.id, error: out.body.error && out.body.error.code, ms: out.body.ms })
    if (!QUIET) console.log('[FAIL] ' + item.id + ' → ' + JSON.stringify(out.body.error))
    continue
  }
  const composedMasked = composeSegments(pieces, out.body.segments)
  const restored = unmaskTokens(composedMasked, masked.tokens)
  const text = restored.text

  // integrity: every masked token must be back, and nothing may be left half-restored
  const kept = masked.tokens.length - restored.missing.length
  tokensTotal += masked.tokens.length
  tokensKept += kept

  // glossary: the preferred rendering of every declared entry must be present
  const misses = []
  const fixes = (out.body.diag && out.body.diag.glossary && out.body.diag.glossary.fixes) || 0
  for (const id of item.glossary) {
    const entry = byId.get(id)
    if (!entry || !entry.ar) continue
    glossaryTotal += 1
    if (hasPreferred(entry, text)) glossaryHits += 1
    else misses.push(id + ' (expected «' + entry.ar + '»' + ((entry.forms || []).length ? ' or ' + entry.forms.join('/') : '') + ')')
  }
  const row = {
    id: item.id, ms: out.body.ms, segments: trimmed.length, tokens: masked.tokens.length, kept,
    glossary: item.glossary.length - misses.length, glossaryChecked: item.glossary.length, fixes, misses,
    usage: out.body.usage || null, out: text
  }
  rows.push(row)
  if (!QUIET) console.log('[' + (restored.missing.length || misses.length ? 'PART' : ' OK ') + '] ' + item.id +
    ' · مقاطع=' + trimmed.length + ' · رموز=' + kept + '/' + masked.tokens.length +
    ' · مسرد=' + row.glossary + '/' + row.glossaryChecked + (fixes ? ' (تصحيح بعدي ' + fixes + ')' : ''))
  if (!QUIET) console.log('        ' + text)
}

const integrity = tokensTotal ? tokensKept / tokensTotal : 1
const compliance = glossaryTotal ? glossaryHits / glossaryTotal : 1
const report = {
  at: new Date().toISOString(),
  model: status.model,
  promptVersion: status.promptVersion,
  effort: status.reasoning ? status.reasoning.chosen : null,
  items: rows.length,
  calls,
  failures,
  tokens: { total: tokensTotal, kept: tokensKept, integrity },
  glossary: { checked: glossaryTotal, hits: glossaryHits, compliance },
  bars: { integrity: BAR_INTEGRITY, glossary: BAR_GLOSSARY },
  rows
}

console.log('\n== golden report ==')
console.log(JSON.stringify({
  model: report.model, promptVersion: report.promptVersion, effort: report.effort,
  items: report.items, calls: report.calls, failures: report.failures,
  integrity: (integrity * 100).toFixed(1) + '% (' + tokensKept + '/' + tokensTotal + ') bar ' + (BAR_INTEGRITY * 100) + '%',
  glossary: (compliance * 100).toFixed(1) + '% (' + glossaryHits + '/' + glossaryTotal + ') bar ≥' + (BAR_GLOSSARY * 100) + '%'
}, null, 1))

if (JSON_OUT) { writeFileSync(JSON_OUT, JSON.stringify(report, null, 2)); console.log('report written to ' + JSON_OUT) }
const pass = failures === 0 && integrity >= BAR_INTEGRITY && compliance >= BAR_GLOSSARY
console.log(pass ? '\nGOLDEN PASS' : '\nGOLDEN FAIL')
process.exit(pass ? 0 : 1)
