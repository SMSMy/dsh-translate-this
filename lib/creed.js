/**
 * creed.js — one source of doctrine, two adaptations (PLAN.md D7).
 *
 * The engine speaks to a **model** whose only job is to translate one batch of segments. The
 * skill speaks to an **agent** whose job is to translate a file the user asked for, using the
 * plugin's own route. Those two audiences need different words, and the failure this file exists
 * to prevent is the quiet one: agent vocabulary (tools, sessions, workspaces, "call the tool")
 * drifting into the engine prompt, where it does nothing but confuse a translator — or, worse,
 * inviting the model to answer instead of translate.
 *
 * `tools/creed-gate.mjs` is the CI step that keeps them apart, and it is a build failure, not a
 * convention: the gate reads THIS file and refuses a release when (a) agent markers appear in the
 * engine text, or (b) the skill description has lost the words an agent would search for.
 */

/** Vocabulary that belongs to the agent half. None of it may appear in the engine's manner. */
export const AGENT_MARKERS = [
  'tool call', 'function call', 'call the tool', 'AGENTS.md', 'workspace', 'session id',
  'skill catalog', 'bash', 'grep', 'todo list', 'you must use the tool', 'ctx.skills'
]

/** Words a requesting agent (or the human asking it) would search for. The skill must carry them. */
export const LAUNCH_WORDS = ['translate', 'translation', 'ترجم', 'ترجمة', 'professional', 'احترافية']

/**
 * The engine's manner, per target language. Rules only about translating, in the model's own
 * register — no tools, no conversation, no "explain", no commentary. Code, paths, commands,
 * URLs, numbers and placeholders must survive byte-for-byte; since 0.6 they are additionally
 * MASKED before they are sent (PLAN.md §6.1), so this rule and a check stand behind them.
 */
export const ENGINE_RULES = [
  '1. Output ONLY the translation. No quotes, no notes, no explanation, no alternatives.',
  '2. Keep code, identifiers, file paths, shell commands, URLs, versions, numbers and',
  '   {placeholders} exactly as they are — never translate them, never reformat them.',
  '3. Keep the original line breaks, bullet markers and leading/trailing whitespace.',
  '4. Use fluent, professional prose in the target language. Never transliterate Latin words.',
  '5. If the text is already in the target language, return it unchanged.'
]

/** The batch rules: a separate variant on purpose, so a single segment pays for no markers. */
export const BATCH_RULES = [
  '6. The input holds several segments. Each segment starts on its own line with a marker',
  '   of the exact form <<<DCT:n>>> where n is its number, and the segments are numbered',
  '   1, 2, 3 … in order.',
  '7. Output every segment, in the same order, each on its own line preceded by its OWN',
  '   marker, copied character for character: <<<DCT:1>>>, then the translation of segment 1,',
  '   then <<<DCT:2>>>, and so on.',
  '8. Never merge two segments, never split one, never reorder them, never add or drop a',
  '   marker, and never translate or modify a marker. No text before the first marker and',
  '   no text after the last segment.'
]

/**
 * The agent-facing skill. Registered at runtime (when the host exposes a skills service and the
 * owner has switched it on) — the description carries the launch words, the content carries the
 * workflow: use the plugin's route, keep code verbatim, never invent a term the glossary owns.
 *
 * The field names are the SERVICE's, not ours, and they were checked against the shipped
 * `dsh-skill` type rather than guessed: `SkillRegistration` = `Omit<SkillDefinition,
 * 'invocation'|'provider'>`, and `SkillDefinition` carries `content: string` and
 * `source: SkillSource` (`'runtime'` is one of them). This object used to ship `body`, and the
 * measured consequence was a skill that registered "successfully" and could never be loaded:
 * `validateRuntimeSkill` does not look at the content, while the read path calls
 * `validateDefinition`, which throws `content must be a string` (probe: with `content` +
 * `source` the same text returns `contentLength:1508`).
 */
export const SKILL = {
  name: 'translate-this',
  description: 'Translate a file or a block of prose into Arabic (or another target) with the user\'s own model: professional translation, glossary terms respected, code and identifiers kept verbatim. استخدمها عند طلب «ترجم هذا الملف» أو «ترجمة احترافية» أو translate this file.',
  whenToUse: 'The user asks for a translation of a file, a block of prose, a README or a document — not for the interface language itself (that is the language pack).',
  source: 'runtime',
  content: [
    '# Translate This (agent skill)',
    '',
    'You are translating CONTENT the user pointed at — a file, a block of prose, a document.',
    'The engine is the user\'s own model, reached through this plugin\'s host route; there is no',
    'external service and no second key.',
    '',
    '## How to translate',
    '',
    '1. Split the text into sentences, keeping every separator: `segments.join("") === text`.',
    '   Never cut inside `` `code` ``, a URL, a path or a `{placeholder}`.',
    '2. Mask atomic tokens before sending them, and restore them after — the plugin\'s own',
    '   `maskTokens`/`unmaskTokens` are the shipping implementation of that rule.',
    '3. Send at most 8 segments or 1800 characters per call to `/dsh-translate-this/translate`',
    '   with `{ "segments": [...], "target": "ar" }`.',
    '4. A reply that is short, out of order, or missing a `<<<DCT:n>>>` marker is a FAILED batch:',
    '   throw it away and retry once. Never store or show a half-aligned batch.',
    '5. The glossary in `data/glossary.js` decides terminology. Use the preferred rendering;',
    '   never use a rendering listed under `avoid`. Terms marked `keep` stay verbatim.',
    '6. Report the cost: the route returns `usage` (input, output, cache) and the host keeps a',
    '   metadata-only call log at `/dsh-translate-this/log`.',
    '',
    '## What not to do',
    '',
    '- Do not translate reasoning, code blocks, terminals or editors.',
    '- Do not invent a term the glossary already rules on, and do not add explanations to the',
    '  translation: the output is a translation, not a commentary.',
    '- Do not send anything to a third-party translation service.'
  ].join('\n')
}

/** The engine system prompt for one call. `batch` adds the separator contract. */
export function enginePrompt(language, batch) {
  return [
    'You translate user-interface text for a developer tool into ' + language + '.',
    'Rules:'
  ].concat(ENGINE_RULES, batch ? BATCH_RULES : []).join('\n')
}
