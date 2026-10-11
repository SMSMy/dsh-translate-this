/**
 * glossary.js — the terminology engine, host side (PLAN.md D7).
 *
 * One source of terms (`data/glossary.js`, generated from `dsh-arabic`), and three jobs:
 *
 *   - **Before the call**: tell the model which preferred renderings apply to THIS text. A
 *     glossary the model never sees is a wish; a glossary in the prompt is an instruction.
 *   - **After the call**: check what came back, and repair what is deterministically
 *     repairable — if the translation uses a rendering the glossary explicitly rejects
 *     (`avoid`) and the preferred one is absent, the preferred one wins. That is the
 *     post-edit step, and it only touches words the glossary already ruled on.
 *   - **Report**: hits, fixes and misses are counted and returned as metadata, because
 *     «≥90% التزام بالمسرد» is an acceptance criterion (PLAN.md هـ3) and a criterion needs a
 *     number, not an impression.
 *
 * Matching is longest-first with `\p{L}`/`\p{N}` boundaries under the `u` flag. Never `\b`:
 * JavaScript's `\b` is defined on `\w`, which is Latin-only, so it silently fails to bound an
 * Arabic term — a bug this project already documented before writing a line of this file.
 */
import { GLOSSARY, GLOSSARY_VERSION } from '../data/glossary.js'

export { GLOSSARY, GLOSSARY_VERSION }

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Every term, longest first, so "system prompt" wins over "prompt" and "plugin bundle" over "bundle". */
const ORDERED = GLOSSARY
  .flatMap((entry) => entry.en.map((term) => ({ entry, term })))
  .filter((pair) => pair.term && pair.term.trim() !== '')
  .sort((a, b) => b.term.length - a.term.length)

const RE_CACHE = new Map()
const reFor = (term) => {
  let re = RE_CACHE.get(term)
  if (!re) {
    re = new RegExp('(?<![\\p{L}\\p{N}])' + escapeRe(term) + '(?![\\p{L}\\p{N}])', 'giu')
    RE_CACHE.set(term, re)
  }
  re.lastIndex = 0
  return re
}

/** Does this exact term appear in the text as a whole term? */
export function hasTerm(text, term) {
  return reFor(term).test(String(text ?? ''))
}

/**
 * Does the translation carry this entry's preferred rendering?
 *
 * Two tolerances, both earned by measurement rather than by mood:
 *
 *   - **Clitics.** Arabic attaches the conjunction, the preposition and the definite article to
 *     the word itself: الجلسة appears as «للجلسة» or «بالجلسة», and الافتراضي as «والافتراضي».
 *     A strict letter-boundary check therefore counted compliant translations as failures —
 *     measured: the same twelve items scored 97.3% with a plain containment check and 56.8% with
 *     the strict one. An under-counting metric is as useless as an over-counting one, so a term
 *     that occurs anywhere is accepted as present.
 *   - **Inflection.** Arabic plurals change the skeleton (مقطع → مقاطع), which no containment
 *     check can see, so an entry may declare `forms`: curated DATA, not a looser check.
 */
export function hasPreferred(entry, text) {
  if (!entry?.ar) return false
  const s = String(text ?? '')
  if (hasTerm(s, entry.ar)) return true                     // exact, whole word: the strict answer
  if (s.includes(entry.ar)) return true                     // a clitic is attached: still the term
  return (entry.forms || []).some((form) => hasTerm(s, form) || s.includes(form))
}

/**
 * Which glossary entries does this text touch? Longest term first; one entry per hit, with the
 * surface form that matched so the hint can quote the text's own wording.
 */
export function termsIn(text, limit = 8) {
  const s = String(text ?? '')
  const found = new Map()
  for (const pair of ORDERED) {
    if (found.size >= limit * 3) break
    const m = reFor(pair.term).exec(s)
    if (!m) continue
    const entry = found.get(pair.entry.id) || { entry: pair.entry, matched: [] }
    if (!entry.matched.includes(m[0])) entry.matched.push(m[0])
    found.set(pair.entry.id, entry)
  }
  return Array.from(found.values()).slice(0, limit)
}

/**
 * The instruction line for a batch, or '' when the text touches no term.
 *
 * Deliberately terse and imperative: the engine is a translator, not a terminologist, and a
 * glossary paragraph would compete with the text it is meant to serve.
 */
export function hintFor(segments, limit = 8) {
  const rows = []
  const seen = new Set()
  for (const segment of segments) {
    for (const { entry } of termsIn(segment, limit)) {
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      if (rows.length >= limit) break
      const forms = entry.en.slice(0, 3).join(' / ')
      if (entry.keep) rows.push('"' + forms + '" → keep it exactly as written, do not translate it')
      else if (entry.ar) {
        const avoid = entry.avoid && entry.avoid.length ? ' (never ' + entry.avoid.map((a) => '«' + a + '»').join(' or ') + ')' : ''
        rows.push('"' + forms + '" → «' + entry.ar + '»' + avoid)
      }
    }
  }
  if (!rows.length) return ''
  return ['Terminology for this text — use these renderings exactly:', ...rows.map((r) => '- ' + r)].join('\n')
}

/** Replace a rejected rendering with the preferred one, outside `code spans` only. */
function fixAvoided(translation, entry) {
  if (!entry.ar || !entry.avoid || !entry.avoid.length) return { text: translation, fixed: 0 }
  const parts = String(translation).split(/(`[^`]*`)/)      // odd indexes are code spans
  let fixed = 0
  for (let i = 0; i < parts.length; i += 2) {
    for (const bad of entry.avoid) {
      const re = new RegExp('(?<![\\p{L}\\p{N}])' + escapeRe(bad) + '(?![\\p{L}\\p{N}])', 'gu')
      if (re.test(parts[i])) {
        parts[i] = parts[i].replace(re, entry.ar)
        fixed += 1
      }
    }
  }
  return { text: parts.join(''), fixed }
}

/**
 * One segment, checked and (where the glossary is explicit) repaired.
 * @returns `{ text, hits, fixes, misses, terms }` — all counts, plus the term ids for the log.
 */
export function verifySegment(source, translation, entries) {
  let text = String(translation ?? '')
  let hits = 0
  let fixes = 0
  const misses = []
  for (const { entry } of entries) {
    const inSource = entry.en.some((term) => hasTerm(source, term))
    if (!inSource) continue
    if (entry.keep) {
      const kept = entry.en.some((term) => hasTerm(text, term))
      if (kept) hits += 1
      else misses.push(entry.id)                 // translating a product name is not repairable by substitution
      continue
    }
    if (hasPreferred(entry, text)) { hits += 1; continue }
    const fixed = fixAvoided(text, entry)
    if (fixed.fixed > 0) { text = fixed.text; fixes += 1; hits += 1; continue }
    misses.push(entry.id)
  }
  return { text, hits, fixes, misses }
}

/** Verify a whole reply, segment by segment, and summarise it for the caller. */
export function verifyBatch(sources, translations, entriesBySegment) {
  const out = []
  let hits = 0
  let fixes = 0
  const misses = []
  for (let i = 0; i < translations.length; i += 1) {
    const res = verifySegment(sources[i] ?? '', translations[i], entriesBySegment[i] || [])
    hits += res.hits
    fixes += res.fixes
    if (res.misses.length) misses.push(...res.misses)
    out.push(res.text)
  }
  return { segments: out, glossary: { hits, fixes, misses: misses.length, missed: misses.slice(0, 6), terms: hits + misses.length } }
}
