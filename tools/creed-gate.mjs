/**
 * creed-gate.mjs — the CI step that keeps the two audiences apart (PLAN.md D7 · §7).
 *
 * One source of doctrine, two adaptations: an engine prompt that speaks to a model, and a skill
 * that speaks to an agent. What this gate refuses to ship:
 *
 *   (أ) **Agent vocabulary inside the engine prompt.** A translator that is told about tools,
 *       sessions or workspaces has been handed instructions it cannot follow — and an invitation
 *       to answer instead of translate. The marker list lives in `lib/creed.js` so the rule and
 *       the text it governs are reviewed together.
 *   (ب) **A skill description that lost its launch words.** An agent finds a skill by scanning
 *       names and descriptions, so a description without "translate"/«ترجمة»/«احترافية» is a skill
 *       nobody will ever load. The gate also checks the description length the catalog allows.
 *   (ج) **A glossary that drifted from its source**, by running the builder in `--check` mode.
 *
 * Exit 0 = the creed holds. Exit 1 = a specific, named violation.
 *
 * Usage: node tools/creed-gate.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const { ENGINE_RULES, BATCH_RULES, AGENT_MARKERS, LAUNCH_WORDS, SKILL, enginePrompt } =
  await import(new URL('../lib/creed.js', import.meta.url).href)

const problems = []
const note = (ok, line) => { console.log((ok ? '[PASS] ' : '[FAIL] ') + line); if (!ok) problems.push(line) }

/* (أ) the engine prompt carries no agent vocabulary ------------------------------------- */
const engineSingle = enginePrompt('Arabic', false)
const engineBatch = enginePrompt('Arabic', true)
const lower = (engineSingle + '\n' + engineBatch).toLowerCase()
const leakedMarkers = AGENT_MARKERS.filter((marker) => lower.includes(marker.toLowerCase()))
note(leakedMarkers.length === 0,
  'أ · موجّه المحرّك خالٍ من مفردات الوكيل' + (leakedMarkers.length ? ' — تسرّب: ' + leakedMarkers.join(', ') : ' (' + AGENT_MARKERS.length + ' علامة فُتشت · ' + (engineSingle.length + engineBatch.length) + ' حرفًا)'))

/* (ب) the skill still says what an agent searches for ----------------------------------- */
const description = String(SKILL.description || '')
const missingWords = LAUNCH_WORDS.filter((word) => !description.toLowerCase().includes(word.toLowerCase()))
note(missingWords.length === 0,
  'ب · وصف السكيل يحمل كلمات الإطلاق' + (missingWords.length ? ' — ناقص: ' + missingWords.join(', ') : ' (' + LAUNCH_WORDS.length + ' كلمة · ' + description.length + ' حرفًا)'))
note(SKILL.name === 'translate-this' && description.length <= 500 && String(SKILL.content || '').length > 400,
  'ب٢ · اسم السكيل وحدود الفهرس والجسم (اسم=' + SKILL.name + ' · وصف=' + description.length + '/500 · جسم=' + String(SKILL.content || '').length + ')')

/* (ب٣) the shape the skills SERVICE accepts ---------------------------------------------
   Measured the hard way: this object used to carry `body`, and `dsh-skill` answered with a
   skill that registered cleanly and could never be loaded (`content must be a string` on the
   read path, because `SkillRegistration` = `SkillDefinition` minus two fields, and
   `SkillDefinition.content` is the body). A rename that only the register call sees is
   invisible until an agent asks for the skill — so it is checked at build time instead. */
const skillKeys = Object.keys(SKILL).sort().join(',')
note(typeof SKILL.content === 'string' && SKILL.content.length > 400 && SKILL.source === 'runtime' && !('body' in SKILL),
  'ب٣ · شكل السكيل مطابق لعقد الخدمة (مفاتيح=' + skillKeys + ' · content=' + typeof SKILL.content + '/' + String(SKILL.content || '').length + ' · source=' + String(SKILL.source) + ')')

/* (أ٢) the two adaptations are genuinely different texts --------------------------------- */
const skillText = description + '\n' + String(SKILL.content || '')
note(skillText !== engineSingle && !skillText.includes(ENGINE_RULES[0]),
  'ج · الجمهوران نصّان مختلفان (لا نسخة واحدة تُقلَّد للاثنين)')

/* (د) the glossary is in sync with its source ------------------------------------------- */
let glossaryOk = true
let glossaryOut = ''
try {
  glossaryOut = execFileSync(process.execPath, [join(HERE, 'glossary-build.mjs'), '--check'], { encoding: 'utf8' }).trim()
} catch (error) {
  glossaryOk = false
  glossaryOut = String(error.stdout || error.message).trim().split('\n')[0]
}
note(glossaryOk, 'د · المسرد متزامن مع مصدره — ' + glossaryOut)

const engineWords = engineSingle.split(/\s+/).length
console.log('\n' + (problems.length ? problems.length + ' مشكلة — CREED GATE CLOSED' : 'CREED GATE OPEN · موجّه المحرّك ' + engineWords + ' كلمة · السكيل ' + description.length + ' حرف وصفًا'))
process.exit(problems.length ? 1 : 0)
