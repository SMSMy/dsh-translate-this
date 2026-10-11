/**
 * glossary-build.mjs — derive OUR glossary from the one that already exists.
 *
 * `dsh-arabic/data/glossary.yml` is the single source of truth for Arabic terminology on this
 * machine (PLAN.md D7). We READ it — never write to it — and add the terms this project's own
 * domain needs (batches, segments, alignment, tokens). A second glossary written by hand would
 * drift from the first one within a release.
 *
 * The output is `data/glossary.js`: a plain ES module, because the host half imports it as a
 * file (no JSON import attributes, no loader surprises) and the CI gate reads the same file.
 *
 * The parser is deliberately small: it understands exactly the YAML shape that glossary has
 * (a list of maps with scalars, flow lists, `do_not_translate`, and block scalars we skip).
 * If the source ever needs more, this fails loudly instead of guessing.
 *
 * Usage: node tools/glossary-build.mjs [--check]
 *   --check  compare with the file on disk and exit 1 when they differ (CI)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SOURCE = process.env.DCT_GLOSSARY_SOURCE || 'C:/Code-backup/dsh-arabic/data/glossary.yml'
const OUT = join(ROOT, 'data', 'glossary.js')

/** Our own domain terms: the words a reader of THIS plugin's panels sees. */
const EXTRA = [
  { id: 'batch', en: ['batch', 'batches'], ar: 'دفعة', forms: ['دفعات', 'دفعتين'], avoid: ['حزمة'] },
  { id: 'segment', en: ['segment', 'segments'], ar: 'مقطع', forms: ['مقاطع', 'مقاطعَ'], avoid: ['قطعة'] },
  { id: 'alignment', en: ['alignment'], ar: 'محاذاة' },
  { id: 'cache hit', en: ['cache hit'], ar: 'إصابة الكاش', forms: ['إصابات الكاش'], avoid: ['إصابة الذاكرة المؤقتة'] },
  { id: 'glossary', en: ['glossary'], ar: 'المسرد', forms: ['مسرد', 'المسارد'], avoid: ['قائمة المصطلحات'] },
  { id: 'on demand', en: ['on demand', 'on-demand'], ar: 'عند الطلب', avoid: ['على الطلب'] },
  { id: 'tool output', en: ['tool output'], ar: 'مخرجات الأدوات', forms: ['مخرجات الأداة'], avoid: ['إخراج الأداة'] },
  { id: 'file preview', en: ['file preview', 'file previews'], ar: 'معاينة الملف', forms: ['معاينات الملفات', 'معاينة ملف'], avoid: ['عرض الملف'] },
  { id: 'plugin panel', en: ['plugin panel', 'plugin panels'], ar: 'لوحة البلاقن', forms: ['لوحات البلاقن'], avoid: ['لوحة الإضافة'] },
  { id: 'fallback', en: ['fallback'], ar: 'احتياطي', forms: ['احتياطية'], avoid: ['التراجع'] },
  { id: 'settle window', en: ['settle window'], ar: 'نافذة الاستقرار', forms: ['نوافذ الاستقرار'] },
  { id: 'counter', en: ['counter'], ar: 'عدّاد', forms: ['عدّادات', 'العدّادات'], avoid: ['عداد'] },
  { id: 'metadata', en: ['metadata'], ar: 'ميتاداتا', forms: ['البيانات الوصفية'], avoid: ['بيانات وصفية'] },
  { id: 'acceptance gate', en: ['acceptance gate'], ar: 'بوابة القبول', forms: ['بوابات القبول'] },
  { id: 'ceiling', en: ['ceiling', 'ceilings'], ar: 'سقف', forms: ['سقوف', 'سقفًا'], avoid: ['حد أقصى'] },
  { id: 'engine', en: ['engine'], ar: 'المحرّك', forms: ['محرّك', 'المحركات'], avoid: ['محرك'] },
  { id: 'verbatim', en: ['verbatim'], ar: 'حرفيًّا', forms: ['حرفيًا', 'حرفي'], avoid: ['حرفيا'] },
  { id: 'plugin bundle', en: ['plugin bundle'], ar: 'حزمة البلاقن' },
  { id: 'keep verbatim (our identifiers)', en: ['ctx.llm.stream', 'translateBatch', 'dsh-translate-this', 'data-dct-ignore', 'reasoningEffort', 'Logcat', 'DeepSeek Harness'], keep: true },
  { id: 'keep verbatim (CLI and files)', en: ['npx', 'pnpm', 'node_modules', 'package.json', 'cordis.patch.yml', 'acceptance/run.mjs', 'lib/client.js', 'lib/index.js'], keep: true }
]

/** Parse the subset of YAML the glossary uses. Fails loudly on anything else. */
function parseGlossary(text) {
  const lines = text.split(/\r?\n/)
  const entries = []
  let current = null
  let skipping = false
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    if (/^\s*#/.test(raw) || raw.trim() === '') continue
    const item = /^-\s+term:\s*(.+)$/.exec(raw)
    if (item) {
      current = { id: item[1].trim(), en: [], ar: null, avoid: [], keep: false }
      entries.push(current)
      skipping = false
      continue
    }
    if (!current) continue
    if (/^\s{2,}\S/.test(raw) === false) { current = null; continue }
    if (skipping) {                                     // inside a block scalar: skip to the next top-level key
      if (/^\s{2}\w/.test(raw)) continue
      skipping = false
    }
    const kv = /^\s+([a-z_]+):\s*(.*)$/.exec(raw)
    if (!kv) continue
    const [, key, valueRaw] = kv
    const value = valueRaw.trim()
    if (key === 'notes' && (value === '|' || value === '>')) { skipping = true; continue }
    if (key === 'en') { current.en = splitList(value); continue }
    if (key === 'ar') { current.ar = value.replace(/^["']|["']$/g, ''); continue }
    if (key === 'avoid') { current.avoid = splitList(value); continue }
    if (key === 'do_not_translate') { current.keep = value === 'true'; continue }
    if (key === 'term' || key === 'notes') continue
    throw new Error('glossary-build: unexpected key "' + key + '" on line ' + (i + 1) + ' — extend the parser instead of guessing')
  }
  return entries
}

const splitList = (value) => {
  const flow = /^\[(.*)\]$/.exec(value)
  const body = flow ? flow[1] : value
  return body.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter((s) => s !== '' && s !== '…')
}

const source = readFileSync(SOURCE, 'utf8')
const derived = parseGlossary(source).map((e) => ({
  id: e.id,
  en: e.en,
  ar: e.keep ? null : e.ar,
  forms: [],
  avoid: e.avoid,
  keep: !!e.keep
}))
const merged = derived.concat(EXTRA.map((e) => ({ id: e.id, en: e.en, ar: e.ar || null, forms: e.forms || [], avoid: e.avoid || [], keep: !!e.keep })))

const header = [
  '/**',
  ' * GENERATED — do not edit by hand. Run `node tools/glossary-build.mjs`.',
  ' *',
  ' * Source: ' + SOURCE.replace(/\\/g, '/') + ' (read-only) + the EXTRA list in the tool.',
  ' * ' + merged.length + ' entries: ' + merged.filter((e) => e.keep).length + ' keep-verbatim, ' +
    merged.filter((e) => !e.keep && e.ar).length + ' translated, ' +
    merged.filter((e) => !e.keep && !e.ar).length + ' without an Arabic form yet.',
  ' */',
  'export const GLOSSARY_VERSION = ' + JSON.stringify('glossary-v1') + '',
  'export const GLOSSARY = ' + JSON.stringify(merged, null, '\t'),
  ''
].join('\n')

if (process.argv.includes('--check')) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : ''
  if (current !== header) {
    console.error('glossary drift: data/glossary.js does not match the source. Run: node tools/glossary-build.mjs')
    process.exit(1)
  }
  console.log('glossary in sync · ' + merged.length + ' entries')
  process.exit(0)
}

mkdirSync(join(ROOT, 'data'), { recursive: true })
writeFileSync(OUT, header)
console.log('wrote data/glossary.js · ' + merged.length + ' entries · ' + merged.filter((e) => e.keep).length + ' keep-verbatim')
