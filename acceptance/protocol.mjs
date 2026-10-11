/**
 * protocol.mjs — the two pieces of 0.6 part two that are pure logic, measured in node.
 *
 * Why a second gate at all: the acceptance page measures the LAYER in a browser (injection,
 * flicker, restore, the batch contract as the layer sees it). Two things underneath it never
 * appear there, and both are the kind that fail silently:
 *
 *   - **The splitter.** Segments are translated apart and glued back. If a cut loses a byte,
 *     every translation built on it is corrupt and the browser gate would still pass, because
 *     it only ever checks that Arabic appeared. So the invariant `segments.join("") === text`
 *     is asserted here on real shapes — code spans, URLs, Arabic punctuation, one endless
 *     paragraph — not on a happy path.
 *   - **The alignment parser.** "The marker must come back verbatim, in order, once per
 *     segment" has five distinct ways to break (a missing marker, a reordered one, one that
 *     leaked into a translated segment, an empty slot, text before the first marker) and each
 *     one must be REFUSED — with a detail that names which contract broke. The host half
 *     cannot be exercised without a model, but its parser can: it is exported for exactly this.
 *
 * Both live in the shipping files (`lib/client.js` and `lib/index.js`), loaded here through
 * the same contracts the runtime uses — the client bundle through `window.__ModuleLoader__`,
 * the host half as an ES module. No copies.
 *
 * Usage: node acceptance/protocol.mjs      (exit 0 = all refused/accepted as declared)
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const RESULTS = []
const check = (name, ok, detail) => { RESULTS.push({ name, ok, detail }); console.log((ok ? '[PASS] ' : '[FAIL] ') + name + (detail ? '\n         ' + detail : '')) }

/* ---------------------------------------------------------------- load the shipping code --- */
let definition = null
globalThis.window = { __ModuleLoader__: { load: (d) => { definition = d } } }
const clientSource = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
new Function('window', clientSource)(globalThis.window)
if (!definition || typeof definition.factory !== 'function') {
  console.error('could not load lib/client.js through window.__ModuleLoader__ — nothing was measured')
  process.exit(2)
}
const client = definition.factory(() => ({}))
const host = await import(new URL('../lib/index.js', import.meta.url).href)
const { splitSegments, composeSegments } = client
const { parseBatchReply, buildBatchContent, maxTokensFor } = host

/* ------------------------------------------------------------------------- the splitter --- */
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const SAMPLES = [
  'The quick brown fox jumps over the lazy dog. It keeps jumping all afternoon.',
  'First sentence here. Second sentence there! Third one? Yes, a third one follows.',
  'مرحبا بك في التطبيق. هذه جملة ثانية طويلة بعض الشيء. وهذه ثالثة؟ نعم.',
  'Open https://example.com/path?a=1.2 for the docs. Then run npx @deepseek-ai/dsh web to start it.',
  'Read README.md first. Then see package.json for the version number of the tools.',
  'Run `npm run build. now` before you commit anything at all. Then push.',
  'One single sentence with no terminator at all and it just keeps going without end',
  'واحد',
  '',
  'A. B. C. D. E. F. G. H. I. J. K. L.'
]

let invariant = true
let detail = []
for (const sample of SAMPLES) {
  const text = norm(sample)
  const pieces = splitSegments(text)
  if (pieces.join('') !== text) { invariant = false; detail.push('LOST BYTES: ' + JSON.stringify(text.slice(0, 40))) }
}
check('1 · التقطيع لا يفقد بايتًا: segments.join("") === text على كل الأنماط',
  invariant, detail.length ? detail.join(' | ') : SAMPLES.length + ' نمطًا (إنجليزي · عربي · رابط · كود · فقرة بلا فاصل · قصير · فارغ)')

const urlCut = splitSegments(norm('Open https://example.com/path?a=1.2 for the docs. Then run npx @deepseek-ai/dsh web to start it.'))
const codeCut = splitSegments(norm('Run `npm run build. now` before you commit anything at all. Then push everything you have.'))
const mdCut = splitSegments(norm('Read README.md first. Then see package.json for the version number of the tools.'))
check('2 · لا تقطيع داخل رابط أو `كود` أو اسم ملف (نقطة بلا فراغ بعدها)',
  urlCut.length === 2 && urlCut[0].includes('example.com/path?a=1.2') &&
  codeCut.length === 2 && codeCut[0].includes('`npm run build. now`') &&
  mdCut.length === 2 && mdCut[0].includes('README.md'),
  'رابط=' + urlCut.length + ' · كود=' + codeCut.length + ' · ملف=' + mdCut.length + ' مقاطع')

const fa = splitSegments(norm('مرحبا بك في التطبيق. هذه جملة ثانية طويلة بعض الشيء. وهذه ثالثة طويلة أليست كذلك؟ نعم يا صديقي هذا نصٌّ رابع أطول.'))
// Every sentence here is longer than MIN_SEGMENT_CHARS, so this measures the PUNCTUATION and
// nothing else. (A shorter sentence is glued to its neighbour on purpose — measured while
// writing this check, when "وهذه ثالثة؟" plus its tail came back as one piece. That rule has
// its own check below, so a short fixture here would have measured the wrong thing.)
check('3 · الفواصل العربية تقطع فعلًا (؟ و.)', fa.length === 4 && fa[2].trim() === 'وهذه ثالثة طويلة أليست كذلك؟',
  'مقاطع=' + fa.length + ' ← ' + JSON.stringify(fa.map((p) => p.trim().slice(0, 20))))

const shortTail = splitSegments(norm('The file is missing. Really?'))
const shortHead = splitSegments(norm('OK. Now let us look at the next part of the file.'))
check('3ب · المقطع القصير يُلصق بجاره (الذيل خلفًا، والرأس أمامًا)',
  shortTail.length === 1 && shortHead.length === 1,
  'ذيل=' + shortTail.length + ' · رأس=' + shortHead.length + ' ← ' + JSON.stringify([shortTail[0], shortHead[0]]))

const long = norm('x'.repeat(1500))
const longCut = splitSegments(long)
check('4 · الفقرة اللانهائية تُقسَّم بسقف، وبلا فقد بايت',
  longCut.length > 2 && longCut.every((p) => p.length <= 620) && longCut.join('') === long,
  'مقاطع=' + longCut.length + ' · أطولها=' + Math.max(...longCut.map((p) => p.length)))

const samples2 = [norm('One. Two! Three?'), norm('مرحبا. عالم!')]
let identity = true
for (const text of samples2) {
  const pieces = splitSegments(text)
  if (composeSegments(pieces, pieces.map((p) => p.trim())) !== text) identity = false
}
check('5 · التركيب يعيد النصّ حرفيًّا حين تكون الترجمة هي النصّ نفسه', identity, samples2.map((s) => JSON.stringify(s)).join(' · '))

/* ---------------------------------------------------------------- the alignment parser --- */
const roundTrip = buildBatchContent(['أولًا', 'ثانيًا', 'ثالثًا'])
const echoed = parseBatchReply(roundTrip, 3)
check('6 · الصدى الحرفي للدفعة يُقبل ويُفكّ إلى 3 مقاطع',
  echoed.ok && echoed.segments.join('|') === 'أولًا|ثانيًا|ثالثًا',
  echoed.ok ? JSON.stringify(echoed.segments) : 'رُفض: ' + echoed.code + ' ' + echoed.detail)

const BROKEN = [
  { name: '7 · علامة ناقصة (1 من 2)', reply: '<<<DCT:1>>>\nأولًا', count: 2, expect: 'markers 1/2' },
  { name: '8 · ترتيب معكوس (2 قبل 1)', reply: '<<<DCT:2>>>\nثانيًا\n<<<DCT:1>>>\nأولًا', count: 2, expect: 'slot 1 carries marker 2' },
  { name: '9 · تسرّب نصّ العلامة داخل مقطع', reply: '<<<DCT:1>>>\nقال <<<DCT 1>>> هنا\n<<<DCT:2>>>\nثانيًا', count: 2, expect: 'marker text inside segment 1' },
  { name: '10 · مقطع عاد فارغًا', reply: '<<<DCT:1>>>\n\n<<<DCT:2>>>\nثانيًا', count: 2, expect: 'segment 1 came back empty' },
  { name: '11 · نصّ قبل أول علامة', reply: 'تفضّل الترجمة:\n<<<DCT:1>>>\nأولًا\n<<<DCT:2>>>\nثانيًا', count: 2, expect: 'text before the first marker' }
]
let refused = 0
const refusals = []
for (const broken of BROKEN) {
  const out = parseBatchReply(broken.reply, broken.count)
  const ok = out.ok === false && out.code === 'ALIGNMENT_FAILED' && String(out.detail).includes(broken.expect)
  if (ok) refused += 1
  refusals.push(broken.name + ' → ' + (out.ok ? 'قُبل (خطأ!)' : out.detail))
}
check('7 · خمس طرق لكسر المحاذاة كلها تُرفض بـALIGNMENT_FAILED وتسمّي السبب',
  refused === BROKEN.length, refusals.join(' | '))

/* ------------------------------------------------------------------- atomic tokens --- */
const { maskTokens, unmaskTokens } = client
const TOKEN_SAMPLES = [
  'Run `node acceptance/run.mjs` before you commit, then see README.md for v1.2.3 and npx @deepseek-ai/dsh web.',
  'Open https://example.com/path?a=1.2 and call ctx.llm.stream with the --verbose flag to see {placeholders}.',
  'Commit 4f2a9c1e touched lib/client.js and package.json in one go.',
  'Nothing atomic here, just a plain sentence about sessions and caches.'
]
let tokensRoundTrip = true
let maskedClean = true
const roundDetail = []
for (const sample of TOKEN_SAMPLES) {
  const masked = maskTokens(sample)
  const back = unmaskTokens(masked.text, masked.tokens)
  if (back.text !== sample || back.missing.length || back.leaked) { tokensRoundTrip = false; roundDetail.push('ROUNDTRIP: ' + JSON.stringify(sample.slice(0, 40))) }
  // after masking, no code span, URL or file name may remain in the text the model sees
  if (/https?:\/\/|`|@[a-z0-9-]+\/|\.mjs\b|\.json\b/.test(masked.text)) { maskedClean = false; roundDetail.push('LEFTOVER: ' + masked.text.slice(0, 60)) }
}
check('13 · الرموز الذرّية: تُقنَّع ثم تُعاد حرفيًّا، ولا يبقى كود في النصّ المُرسَل',
  tokensRoundTrip && maskedClean, roundDetail.length ? roundDetail.join(' | ') : TOKEN_SAMPLES.length + ' أنماط · مثال: ' + maskTokens(TOKEN_SAMPLES[0]).text)

// §6.1: tokens do NOT enter the cache key — the same sentence with a different URL is one segment.
const a = 'Read https://example.com/one for details about the session.'
const b = 'Read https://example.com/two for details about the session.'
const sameMasked = maskTokens(a).text === maskTokens(b).text
check('14 · تغيّر الرابط وحده ⇒ النصّ المقنَّع واحد (فالرموز لا تدخل مفتاح الكاش)',
  sameMasked, maskTokens(a).text)

// A reply that lost a marker must be REFUSED, not shown: this is the 100% integrity gate.
const maskedSample = maskTokens(TOKEN_SAMPLES[1])
const lost = unmaskTokens(maskedSample.text.replace('<<<K1>>>', ''), maskedSample.tokens)
const mangled = unmaskTokens(maskedSample.text.replace('<<<K1>>>', '<<< K1 >>>'), maskedSample.tokens)
check('15 · ردّ فقد رمزًا محميًّا أو شوّه علامته ⇒ يُرفض (لا حقن ولا تخزين)',
  lost.missing.length === 1 && (mangled.missing.length === 1 || mangled.leaked === true),
  'مفقود=' + JSON.stringify(lost.missing) + ' · مشوّه: مفقود=' + JSON.stringify(mangled.missing) + ' مشوَّه=' + mangled.leaked)

/* ---------------------------------------------------------------------------- ceilings --- */
const tokens = [0, 100, 1000, 3000, 20000].map((n) => maxTokensFor(n))
check('12 · سقف الخرج يتزايد مع الدخل ومقيَّد [512, 4096]',
  tokens.every((t, i) => t >= 512 && t <= 4096 && (i === 0 || t >= tokens[i - 1])),
  'maxTokensFor: ' + tokens.join(' → '))

const failed = RESULTS.filter((r) => !r.ok).length
console.log('\n' + (RESULTS.length - failed) + '/' + RESULTS.length + (failed ? ' — FAILED' : ' · PROTOCOL GATE OPEN'))
process.exit(failed ? 1 : 0)
