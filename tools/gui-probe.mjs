/**
 * gui-probe.mjs — measure the surface selectors against a LIVE DSH GUI.
 *
 * Why this exists: the five surface selectors in `lib/client.js` (`SURFACES`) come from
 * PLAN.md and, until they are measured, every one of them is marked `verified: false`.
 * A wrong selector is a silent no-op — the layer simply finds nothing — and this
 * project's rule is that a silent no-op is a failure, not a mystery. So the first real
 * run is a measurement, and this is the instrument.
 *
 * It reports, in one pass:
 *   - the declared surfaces with the number of roots each selector actually matches,
 *     taken from the injected plugin's own probe (`window.__dshTranslateThis__`), so the
 *     number is the layer's, not the tool's opinion of it;
 *   - match counts for a broad candidate list, to replace a wrong selector with a
 *     measured one;
 *   - structural samples (tag, class names, `data-*` attributes) — NEVER text: the GUI
 *     holds the user's conversation, and a measuring tool has no business copying it;
 *   - whether the header button rendered.
 *
 * Read-only with respect to DSH: it opens a page in its own headless Chrome, evaluates,
 * and closes. It never touches plugin state and never writes to the profile.
 *
 * Usage:
 *   node tools/gui-probe.mjs [--url http://127.0.0.1:19387] [--wait 6000]
 *                            [--json tools/gui-probe.json] [--chrome <path>]
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sleep, defaultChrome, launchChrome, killTree, client, openTab, pageErrors } from '../acceptance/cdp.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i === -1 ? fallback : args[i + 1]
}

const URL_ = argOf('url', 'http://127.0.0.1:19387')
const WAIT = Number(argOf('wait', '6000'))
const JSON_OUT = argOf('json', null)
const CHROME = argOf('chrome', defaultChrome())

/**
 * Candidate selectors. Two lessons are baked in here, both measured:
 *   1. this UI hashes its class names as `<hash>_<semanticName>` (`BynINW_frame`,
 *      `KuQXFq_message`), so `[class*="_message_"]` with a trailing underscore matches
 *      NOTHING — the earlier list was wrong in exactly that way;
 *   2. the shell's own `data-*` markers are the durable ones (`data-conversation-*`,
 *      `data-dockkit-pane`, `data-sidebar-right-panel`, `data-dsh-part`), because no
 *      build step renames them.
 */
const CANDIDATES = [
  '[data-conversation-region]', '[data-conversation-content]', '[data-conversation-scroll]',
  '[data-conversation-session]', '[data-composer-seat]', '[data-dockkit-pane]',
  '[data-sidebar-right-panel]', '[data-sidebar-right-session]', '[data-dsh-part]',
  '[data-plugin]', '[data-slot]', '[data-dsh-plugin]',
  '[class*="_message"]', '[class*="_markdownPayload"]', '[class*="_toolCallPayload"]',
  '[class*="_toolCallOnly"]', '[class*="_toolChanges"]', '[class*="_documentPreview"]',
  '[class*="_composer"]', '[class*="_frame"]', '[class*="_pane_"]',
  'article', '[role="article"]', 'main', 'pre', 'code', 'textarea', '[contenteditable="true"]'
]

const EXPR = `(function () {
  const out = { title: document.title || '', href: location.href, elements: document.querySelectorAll('*').length,
                candidates: {}, samples: {}, plugin: null, buttonText: null, hasArabic: null };
  for (const sel of ${JSON.stringify(CANDIDATES)}) {
    let n = 0;
    try { n = document.querySelectorAll(sel).length } catch (e) { n = -1 }
    out.candidates[sel] = n;
  }
  // structural samples only: tag + class + data-* + id, truncated. No text content.
  const struct = (el) => {
    const attrs = [];
    for (const a of el.attributes) {
      if (a.name === 'class' || a.name === 'id' || a.name.startsWith('data-')) attrs.push(a.name + '=' + a.value.slice(0, 80));
    }
    return '<' + el.tagName.toLowerCase() + ' ' + attrs.join(' ') + '>';
  };
  for (const sel of ${JSON.stringify(CANDIDATES)}) {
    try {
      const els = Array.from(document.querySelectorAll(sel)).slice(0, 2);
      if (els.length) out.samples[sel] = els.map(struct);
    } catch (e) { /* ignore */ }
  }
  const api = window.__dshTranslateThis__;
  if (api && api.layer) {
    out.plugin = { version: api.version || null, engine: api.engine && api.engine.kind,
                   surfaces: Object.fromEntries(Object.entries(api.layer.state).map(([k, s]) => [k, { on: !!s.on, roots: s.roots || 0, selector: s.selector }])) };
    const c = api.layer.counters;
    out.plugin.counters = { requests: c.requests, injections: c.injections, reinjections: c.reinjections, giveUps: c.giveUps, network: c.network };
    out.plugin.loopFlag = !!api.layer.loopFlag;
  }
  const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').includes('ترجم هذا المحتوى'));
  out.buttonText = btn ? 'present' : 'absent';
  out.hasArabic = /[\\u0600-\\u06FF]/.test(document.body.innerText || '') ? 'yes' : 'no';
  return JSON.stringify(out);
})()`

let chrome = null
let profile = null
try {
  profile = await mkdtemp(join(tmpdir(), 'dct-probe-'))
  const launched = await launchChrome(profile, CHROME)
  chrome = launched.child
  const ws = await openTab(launched.port, URL_)
  const api = client(ws)
  await api.send('Runtime.enable')
  await api.send('Log.enable')
  await sleep(WAIT)                                  // let the SPA mount and the session load
  const res = await api.evaluate(EXPR)
  if (res.error) throw new Error('evaluate failed: ' + res.error)
  const report = JSON.parse(res.value)
  report.errors = pageErrors(api)
  ws.close()

  if (JSON_OUT) {
    await mkdir(dirname(JSON_OUT), { recursive: true })
    await writeFile(JSON_OUT, JSON.stringify(report, null, 2))
  }

  console.log(`GUI: ${report.href}`)
  console.log(`title: ${report.title} · elements: ${report.elements} · arabic: ${report.hasArabic}`)
  console.log(`header button «ترجم هذا المحتوى»: ${report.buttonText}`)
  if (report.plugin) {
    console.log(`plugin: v${report.plugin.version} · engine=${report.plugin.engine} · loopFlag=${report.plugin.loopFlag}`)
    console.log('declared surfaces (the layer\'s own probe):')
    for (const [id, s] of Object.entries(report.plugin.surfaces)) {
      console.log(`   ${id.padEnd(9)} on=${String(s.on).padEnd(5)} roots=${String(s.roots).padStart(3)}  ${s.selector}`)
    }
    console.log(`counters: ${JSON.stringify(report.plugin.counters)}`)
  } else {
    console.log('plugin: NOT PRESENT in this page (not injected, or the page loaded before it was)')
  }
  const hits = Object.entries(report.candidates).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
  console.log('candidate selectors with matches:')
  for (const [sel, n] of hits) console.log(`   ${String(n).padStart(5)}  ${sel}`)
  if (report.errors.length) console.log('page errors:\n' + report.errors.map((e) => '   ' + e).join('\n'))
  if (JSON_OUT) console.log(`\nfull report: ${JSON_OUT}`)
} catch (err) {
  console.error('probe failed: ' + (err && err.message ? err.message : String(err)))
  process.exitCode = 2
} finally {
  killTree(chrome)
  if (profile) await rm(profile, { recursive: true, force: true }).catch(() => {})
}
