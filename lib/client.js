/**
 * dsh-translate-this — browser half. Runs inside the dsh web GUI.
 *
 * What it does: translates the content the user points at — replies, tool output,
 * file previews, plugin panels — **on demand**, with the user's own model (0.6), and
 * injects each block the moment it is ready. Reasoning is out of scope (the official
 * plugin covers it), code/terminals/editors are never touched, and nothing is ever
 * sent to a third-party translation service.
 *
 * This file is a PORT, not a rewrite. The layer below — the observer, the queue, the
 * injector, the restore, the generation counter, the give-up rule — is the code that
 * survived `acceptance/index.html`, and that page stays the gate: `node acceptance/run.mjs`
 * runs it in a real browser twice (with frames, and with the fallback scheduler) and
 * must print 5/5 both times before this file is trusted.
 *
 * Three rules from PLAN.md §5 rule 6 are load-bearing here, and each one was measured
 * the hard way:
 *   1. every DOM write this layer makes goes through `muted()` (flag + takeRecords,
 *      never a timeout — a timeout is a race);
 *   2. the observer callback NEVER writes. A write inside a MutationObserver callback
 *      is a microtask storm (write → record → callback → write) that starves timers
 *      and rendering alike: it froze the acceptance page outright;
 *   3. anything inside `[data-dct-ignore]` is skipped structurally, so our own
 *      instrumentation — the panel, the toast, the portaled shell — can never drive
 *      the layer whatever happens to timing.
 *
 * Two deliberate differences from the acceptance page, both stated rather than hidden:
 *   - **Translation is on demand only.** In the page an added node was scheduled for
 *     translation immediately; here the observer never *translates* anything by
 *     itself. New content waits for the user's click (PLAN.md §1.2: an automatic
 *     page-wide translation is a violation of "on demand", so it is an explicit
 *     choice, never a default).
 *   - The observer keeps its other two jobs: re-injecting a **cached** translation
 *     when the app writes the original back over it (that is the anti-flicker rule,
 *     and it costs zero engine calls), and dropping a record when the app recycles
 *     the node for different text (PLAN.md §6.8).
 *
 * Bundle format: `window.__ModuleLoader__.load({id, factory})` (lazy CJS) — the only
 * client bundle format the web shell materializes.
 */
window.__ModuleLoader__.load({
	id: "dsh-translate-this",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const { createElement: h, useEffect, useRef, useState } = require("react");
		const { createRoot } = require("react-dom/client");

		/* ==================================================================== *
		 * 1. surfaces — DECLARED, never assumed (a locked decision of the plan:
		 *    "الأسطح معلنة صراحةً (allowlist) لا مفترضة")
		 * ==================================================================== */

		/**
		 * A surface is a root we are willing to translate inside. Nothing else in the
		 * document is ever touched, so a stray text node outside these roots is not a
		 * risk we manage — it is unreachable by construction.
		 *
		 * `verified: false` means: the selector comes from PLAN.md §3 and has NOT yet
		 * been measured against a running GUI. That is what the panel's probe is for —
		 * a wrong selector shows up there as "0 مستهدف" instead of as silence, which is
		 * the failure mode this project refuses (no silent no-op).
		 */
		const SURFACES = [
			{ id: "replies",  label: "نصّ الردود",       selector: "[data-dsh-chat-message], .dsh-chat-message", on: true,  trust: "stable",    verified: false },
			{ id: "tools",    label: "مخرجات الأدوات",   selector: "[data-dsh-tool-result], .dsh-tool-call",     on: false, trust: "untrusted", verified: false },
			{ id: "files",    label: "معاينات الملفات",  selector: "[data-dsh-document-view], .dsh-document",    on: false, trust: "stable",    verified: false },
			{ id: "panels",   label: "لوحات البلاقنات",  selector: "[data-dsh-plugin-panel]",                     on: false, trust: "untrusted", verified: false },
			{ id: "settings", label: "الإعدادات",        selector: "[data-dsh-settings]",                         on: false, trust: "chrome",    verified: false }
		];

		const IGNORE = "[data-dct-ignore]";
		const MARK = "data-dct-mark";                 // our own marker: direction lives in CSS, not inline
		const SURFACE_ATTR = "data-dct-surface";      // value = surface id, so `closest()` also answers "which one"
		const FRAME_FALLBACK_MS = 32;
		const GIVE_UP_MS = 10000;

		/* ==================================================================== *
		 * 2. the layer (ported from the acceptance page, verified there)
		 * ==================================================================== */

		const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
		const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

		/**
		 * Build the injector layer over a given engine and surface table.
		 * @param options.engine - `{ translate(text) -> Promise<string> }` (0.5: a stub).
		 * @param options.surfaces - surface table to use; defaults to the declared set.
		 *   The acceptance page passes its own table because its fixtures are not DSH's
		 *   DOM — the layer is what is under test there, not the selector list.
		 * @param options.onChange - called when counters/state move, so the UI can redraw.
		 */
		function createLayer(options) {
			const engine = options.engine;
			const table = options.surfaces || SURFACES;
			const notify = () => { try { options.onChange?.(); } catch { /* the UI must never break the layer */ } };

			const L = {
				state: Object.fromEntries(table.map((s) => [s.id, { ...s, roots: 0 }])),
				cache: new Map(),          // content key -> translation (PLAN.md §6.2)
				records: new Map(),        // text node -> { source, translation, key, gen, host, surface }
				hosts: new Map(),          // parent element -> { source, key, surface }: survives a node swap
				queue: [],
				held: new Map(),           // key -> { count, until }: the give-up rule
				gen: 0,
				pending: false,
				loopFlag: false,
				enabled: true,
				rate: [],
				debug: null,               // last failure, shown in the panel rather than swallowed
				counters: { requests: 0, injections: 0, reinjections: 0, giveUps: 0, droppedLate: 0,
				            flickerMs: 0, network: 0, englishSince: new Map() }
			};

			const keyOf = (text) => "auto\u0001ar\u0001stub\u0001v1\u0001" + text;

			/* ---- writing, and staying silent (rule 1 + rule 3) ---- */
			let muteDepth = 0;
			function muted(fn) {
				muteDepth += 1;
				try { return fn(); }
				finally {
					muteDepth -= 1;
					if (muteDepth === 0) observer.takeRecords();
				}
			}
			const insideOwnUi = (node) => {
				const el = node && (node.nodeType === 1 ? node : node.parentElement);
				return !!(el && el.closest && el.closest(IGNORE));
			};

			/* ---- scheduling: rAF with a fallback, because frames are not guaranteed ----
			 * A backgrounded or occluded window gets no frames at all. A layer that
			 * schedules only on rAF stalls silently there: the queue grows and nothing
			 * is ever translated. Measured: in `chrome --dump-dom` the page received
			 * ZERO frames in 1500 ms while timers kept running.
			 *
			 * `?noraf=1` forces the fallback where frames DO exist, so each scheduling
			 * path can be tested on its own (acceptance/run.mjs runs both). It is a
			 * bisect switch, the same kind as the page's `?nobs=1` — not a product option. */
			const NO_FRAMES = (() => {
				try { return new URLSearchParams(location.search).has("noraf"); } catch { return false; }
			})();
			function nextFrame(fn) {
				let done = false;
				const run = () => { if (!done) { done = true; fn(); } };
				const timer = setTimeout(run, FRAME_FALLBACK_MS);
				if (!NO_FRAMES && typeof requestAnimationFrame === "function")
					requestAnimationFrame(() => { clearTimeout(timer); run(); });
				return timer;
			}

			/* ---- what may be translated ---- */
			function surfaceOf(node) {
				const parent = node && node.parentElement;
				if (!parent) return null;
				const host = parent.closest("[" + SURFACE_ATTR + "]");
				if (!host) return null;
				return host.getAttribute(SURFACE_ATTR) || "";
			}

			function eligible(node) {
				if (!L.enabled) return false;
				if (!node || node.nodeType !== 3) return false;
				const text = norm(node.nodeValue || "");
				if (text.length < 8) return false;                       // too short to be prose
				const parent = node.parentElement;
				if (!parent) return false;
				const id = surfaceOf(node);                              // rule: declared surfaces only
				if (id === null) return false;
				const surface = L.state[id];
				if (!surface || !surface.on) return false;
				if (parent.closest(IGNORE)) return false;                // our own surfaces, portals included
				if (parent.closest('pre, code, textarea, input, [contenteditable="true"]')) return false;
				const style = getComputedStyle(parent);
				if (style.display === "none" || style.visibility === "hidden") return false;
				return true;
			}

			/**
			 * Direction goes on OUR mark, never on the React parent's structure: marking
			 * a flex/grid row (or any row that owns controls) reorders its children
			 * (PLAN.md §5 rule 7). One CSS rule does the isolation.
			 */
			function directionHost(node) {
				let el = node.parentElement;
				while (el && el !== document.body) {
					const style = getComputedStyle(el);
					if (style.display === "flex" || style.display === "grid" || style.display === "inline-flex") return null;
					if (el.querySelector('button, a, input, select, textarea, [role="button"], [role="radio"]')) return null;
					if (el.children.length <= 1) return el;
					el = el.parentElement;
				}
				return null;
			}

			/**
			 * A queued element is a block, and a block's text usually sits in nested
			 * inline elements — `span` inside `div` is how DSH's own markup nests it. A
			 * walk that only looked at direct text children would translate the blocks
			 * and silently skip every nested one (measured on the acceptance page).
			 */
			function textNodesIn(root, out, budget) {
				if (out.length >= budget) return;
				const type = root.nodeType;
				if (type === 3) { out.push(root); return; }
				if (type !== 1) return;
				if (insideOwnUi(root)) return;
				const tag = root.tagName;
				if (tag === "PRE" || tag === "CODE" || tag === "TEXTAREA" || tag === "INPUT" ||
				    tag === "SELECT" || tag === "SCRIPT" || tag === "STYLE" || tag === "OPTION") return;
				if (root.isContentEditable) return;
				if (root.closest && root.closest(IGNORE)) return;
				for (const child of root.childNodes) textNodesIn(child, out, budget);
			}

			/* ---- the injector ---- */
			function inject(node, translation, surfaceId) {
				const source = norm(node.nodeValue || "");
				const key = keyOf(source);
				const host = directionHost(node);
				muted(() => {
					node.nodeValue = translation;                        // value only: no structure change
					if (host) { host.setAttribute(MARK, "1"); host.setAttribute("dir", "rtl"); host.style.unicodeBidi = "isolate"; }
				});
				L.records.set(node, { source, translation, key, gen: L.gen, host: host || null, surface: surfaceId ?? surfaceOf(node) });
				// Remember the BLOCK, not just the node: React replaces text nodes as readily as
				// it rewrites them, and a block the user translated must not silently fall back
				// to English because the node it used to hold is gone.
				const parent = node.parentElement;
				if (parent) L.hosts.set(parent, { source, key, surface: surfaceId ?? surfaceOf(node) });
				L.counters.injections += 1;
				const since = L.counters.englishSince.get(node);
				if (since !== undefined) { L.counters.flickerMs += now() - since; L.counters.englishSince.delete(node); }
				guardRate();
				notify();
			}

			/**
			 * The app REPLACED the text node instead of rewriting its value — React does both,
			 * and only one of them sends a `characterData` record. Without this, the replaced
			 * node stays English in a block the user already translated: exactly the flicker
			 * this project's acceptance criterion is written against (PLAN.md §8, result 1).
			 * The translation comes from the cache — zero engine calls — and the same give-up
			 * rule bounds it, so an app that keeps swapping nodes cannot be fought forever.
			 */
			function repair(node) {
				const parent = node.parentElement;
				if (!parent) return false;
				const mem = L.hosts.get(parent);
				if (!mem) return false;
				if (norm(node.nodeValue || "") !== mem.source) return false;
				const cached = L.cache.get(mem.key);
				if (cached === undefined) return false;
				const hold = L.held.get(mem.key) || { count: 0, until: 0 };
				hold.count += 1;
				if (hold.count > 2) {                                    // stable English beats a strobe
					hold.until = now() + GIVE_UP_MS; L.held.set(mem.key, hold);
					L.counters.giveUps += 1; L.cache.delete(mem.key); return false;
				}
				L.held.set(mem.key, hold);
				L.counters.reinjections += 1;
				if (!L.counters.englishSince.has(node)) L.counters.englishSince.set(node, now());
				inject(node, cached, mem.surface);
				return true;
			}

			function dropRecord(node, rec) {
				L.records.delete(node);
				const parent = node.parentElement;
				const mem = parent && L.hosts.get(parent);
				if (mem && rec && mem.key === rec.key) L.hosts.delete(parent);
				if (rec && rec.host) {
					muted(() => { rec.host.removeAttribute(MARK); rec.host.removeAttribute("dir"); rec.host.style.unicodeBidi = ""; });
				}
			}

			async function request(node, surfaceId) {
				const source = norm(node.nodeValue || "");
				const key = keyOf(source);
				const gen = L.gen;
				const cached = L.cache.get(key);
				if (cached !== undefined) { inject(node, cached, surfaceId); return; }
				const hold = L.held.get(key);
				if (hold && now() < hold.until) return;                  // we stopped fighting this key
				L.counters.requests += 1;
				notify();
				let out;
				try {
					out = await engine.translate(source);
				} catch (error) {
					L.debug = "فشل المحرّك: " + String((error && error.message) || error);
					notify();
					return;
				}
				if (gen !== L.gen) { L.counters.droppedLate += 1; notify(); return; }
				if (!node.isConnected) return;
				if (norm(node.nodeValue || "") !== source) { L.counters.droppedLate += 1; return; }
				L.cache.set(key, out);
				inject(node, out, surfaceId);
			}

			function schedule(node) {
				if (L.queue.length < 500 && !L.queue.includes(node)) L.queue.push(node);
				if (!L.pending) {
					L.pending = true;
					nextFrame(() => { L.pending = false; flush(); });
				}
			}

			function flush() {
				const batch = L.queue.splice(0, L.queue.length);
				const seen = new Set();
				for (const item of batch) {
					const nodes = [];
					if (item.nodeType === 3) nodes.push(item);
					else if (item.nodeType === 1) textNodesIn(item, nodes, 300);
					for (const node of nodes) {
						if (seen.has(node) || !eligible(node)) continue;
						seen.add(node);
						const text = norm(node.nodeValue || "");
						const rec = L.records.get(node);
						const cached = L.cache.get(keyOf(text));
						if (cached !== undefined && text !== cached) {              // the app wrote the source back
							const hold = L.held.get(keyOf(text)) || { count: 0, until: 0 };
							hold.count += 1;
							if (hold.count > 2) {                                   // give up: stable English beats a strobe
								hold.until = now() + GIVE_UP_MS; L.held.set(keyOf(text), hold);
								L.counters.giveUps += 1; L.cache.delete(keyOf(text));
							} else {
								L.held.set(keyOf(text), hold);
								L.counters.reinjections += 1;
								if (!L.counters.englishSince.has(node)) L.counters.englishSince.set(node, now());
								inject(node, cached, surfaceOf(node));              // FROM CACHE: no engine call
							}
							continue;
						}
						if (rec && text !== rec.translation) dropRecord(node, rec);  // recycled node
						if (text && !L.records.has(node)) request(node, surfaceOf(node));
					}
				}
				notify();
			}

			/**
			 * The observer never writes and never translates on its own. Its three jobs:
			 * re-inject a cached translation the app overwrote (anti-flicker), forget a
			 * record whose node now carries different text (recycling), and notice that
			 * a surface root appeared or changed so the probe stays truthful.
			 */
			const observer = new MutationObserver((records) => {
				if (!L.enabled || muteDepth > 0) return;
				let rootsMayHaveChanged = false;
				for (const r of records) {
					if (insideOwnUi(r.target)) continue;                              // rule 3
					if (r.type === "characterData") {
						const rec = L.records.get(r.target);
						if (!rec) continue;
						const value = norm(r.target.nodeValue || "");
						if (value === rec.translation) continue;
						if (value === rec.source) {
							// The app wrote the ORIGINAL back over our translation: the flicker
							// clock starts here, not in the flush — otherwise the metric would
							// measure only our own reaction inside one synchronous run.
							if (!L.counters.englishSince.has(r.target)) L.counters.englishSince.set(r.target, now());
							schedule(r.target);
						} else {
							dropRecord(r.target, rec);                                // recycled for other text
						}
						continue;
					}
					rootsMayHaveChanged = true;
					// A replaced node carries the same source under a block we already translated:
					// put the cached translation back instead of leaving English on screen.
					for (const added of r.addedNodes) {
						if (insideOwnUi(added)) continue;
						if (added.nodeType === 3) { repair(added); continue; }
						if (added.nodeType !== 1) continue;
						const inner = [];
						textNodesIn(added, inner, 50);
						for (const t of inner) repair(t);
					}
				}
				if (rootsMayHaveChanged && !L.pending) {
					L.pending = true;
					nextFrame(() => { L.pending = false; scanRoots(); notify(); });
				}
			});
			observer.observe(document.body, { childList: true, subtree: true, characterData: true });

			/* ---- surface discovery: mark the roots we are allowed to work in ---- */
			function scanRoots() {
				let total = 0;
				for (const s of Object.values(L.state)) {
					const found = document.querySelectorAll(s.selector);
					let n = 0;
					muted(() => {
						for (const el of found) {
							if (el.closest(IGNORE)) continue;
							if (el.getAttribute(SURFACE_ATTR) !== s.id) {
								const owner = el.closest("[" + SURFACE_ATTR + "]");       // keep the innermost
								if (owner && owner !== el) continue;
								el.setAttribute(SURFACE_ATTR, s.id);
							}
							n += 1;
						}
					});
					s.roots = n;
					total += n;
				}
				return total;
			}

			/* ---- public operations ---- */
			function translateRoots(ids) {
				const wanted = ids ? [].concat(ids) : Object.values(L.state).filter((s) => s.on).map((s) => s.id);
				let scheduled = 0;
				for (const id of wanted) {
					const s = L.state[id];
					if (!s || !s.on) continue;
					for (const el of document.querySelectorAll(s.selector)) {
						if (el.closest(IGNORE)) continue;
						const nodes = [];
						textNodesIn(el, nodes, 400);
						for (const node of nodes) { if (eligible(node) && !L.records.has(node)) { schedule(node); scheduled += 1; } }
					}
				}
				notify();
				return scheduled;
			}

			function restoreAll() {
				L.gen += 1;                                              // late results are now dead
				L.queue.length = 0;
				let restored = 0;
				muted(() => {
					for (const [node, rec] of L.records) {
						if (node.isConnected && node.nodeValue === rec.translation) { node.nodeValue = rec.source; restored += 1; }
						if (rec.host) { rec.host.removeAttribute(MARK); rec.host.removeAttribute("dir"); rec.host.style.unicodeBidi = ""; }
					}
					document.querySelectorAll("[" + MARK + "]").forEach((el) => {
						el.removeAttribute(MARK); el.removeAttribute("dir"); el.style.unicodeBidi = "";
					});
				});
				L.records.clear();
				L.hosts.clear();
				notify();
				return restored;
			}

			/** Restore one surface only — a switch that is turned off hands the text back. */
			function restoreSurface(id) {
				L.gen += 1;
				let restored = 0;
				muted(() => {
					for (const [node, rec] of Array.from(L.records)) {
						if (rec.surface !== id) continue;
						if (node.isConnected && node.nodeValue === rec.translation) { node.nodeValue = rec.source; restored += 1; }
						dropRecord(node, rec);          // also forgets the block memory: no repair after a restore
					}
				});
				notify();
				return restored;
			}

			/** Cancel: nothing in flight may still touch the screen (PLAN.md §5 rule 5). */
			function cancel() {
				L.gen += 1;
				L.queue.length = 0;
				notify();
				return L.counters.droppedLate;
			}

			function setSurface(id, on) {
				const s = L.state[id];
				if (!s) return;
				s.on = !!on;
				if (!on) restoreSurface(id);
				else { scanRoots(); translateRoots([id]); }
				notify();
			}

			function clearCache() { L.cache.clear(); L.held.clear(); notify(); }

			/** The burst guard: a loop becomes a visible failure instead of a frozen tab. */
			function guardRate() {
				const t = now();
				L.rate = L.rate.filter((x) => t - x < 1000);
				L.rate.push(t);
				if (L.rate.length > 300 && !L.loopFlag) {
					L.loopFlag = true;
					L.enabled = false;
					notify();
				}
			}

			function dispose() {
				observer.disconnect();
				restoreAll();
			}

			const api = {
				state: L.state, counters: L.counters, surfaces: SURFACES,
				get loopFlag() { return L.loopFlag }, get debug() { return L.debug },
				translateRoots, restoreAll, restoreSurface, cancel, setSurface, clearCache,
				scanRoots, dispose,
				/** Exposed for the panel's probe and for driving the layer from a test. */
				_internals: L
			};
			muted(() => {});
			return api;
		}

		/* ==================================================================== *
		 * 3. the engine seam
		 * ==================================================================== */

		/**
		 * 0.5 engine: a fixed, offline stub. It is not a translation and it is not
		 * pretending to be one — every string comes back with an unmistakable marker so
		 * nobody mistakes this build for a working translator, and the panel says so in
		 * plain words.
		 *
		 * 0.6 replaces exactly this object with the host call (`ctx.llm.stream`, decision
		 * D5): batched with an explicit separator, alignment failure thrown away rather
		 * than cached, metadata-only call log. The layer above does not change.
		 */
		const stubEngine = {
			kind: "stub",
			label: "محرّك ثابت (0.5) — لا نموذج ولا شبكة",
			translate(text) {
				return new Promise((resolve) => setTimeout(() => resolve("«ترجمة» " + text), 0));
			}
		};

		/* ==================================================================== *
		 * 4. the UI — button in the conversation header, panel as an overlay
		 * ==================================================================== */

		const STYLE = `
[data-dct-ignore] { }
.dct-btn { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px;
  border: 1px solid var(--dsh-border, rgba(128,128,128,.35)); border-radius: 8px;
  background: transparent; color: inherit; font: inherit; font-size: 12px; cursor: pointer; }
.dct-btn:hover { background: rgba(128,128,128,.14); }
.dct-btn[data-on] { background: rgba(64,120,220,.18); border-color: rgba(64,120,220,.5); }
.dct-panel { position: fixed; inset-block-start: 56px; inset-inline-end: 16px; z-index: 999998;
  width: min(420px, 92vw); max-height: 70vh; overflow: auto; padding: 12px 14px;
  background: light-dark(#fff, #1b1b1f); color: light-dark(#111, #e8e8ea);
  border: 1px solid rgba(128,128,128,.35); border-radius: 12px; box-shadow: 0 10px 30px #0006;
  font: 13px/1.7 -apple-system, "Segoe UI", system-ui, sans-serif; text-align: start; }
.dct-title { font-weight: 600; margin: 0 0 6px; }
.dct-sec { margin-top: 10px; padding-top: 8px; border-top: 1px solid rgba(128,128,128,.25); }
.dct-kv { display: flex; justify-content: space-between; gap: 12px; }
.dct-kv b { font-weight: 600; }
.dct-row { display: flex; align-items: center; gap: 8px; justify-content: space-between; padding: 2px 0; }
.dct-note { opacity: .75; font-size: 12px; }
.dct-warn { color: #d08a2a; }
.dct-bad { color: #d05555; font-weight: 600; }
.dct-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
[data-dct-mark] { unicode-bidi: isolate; }
`;

		function button(label, onClick, extra) {
			return h("button", Object.assign({ className: "dct-btn", type: "button", onClick, "data-dct-ignore": "" }, extra || {}), label);
		}

		/** The panel: state, counters, surface switches with a live probe, and the actions. */
		function Panel(props) {
			const layer = props.layer;
			const [, bump] = useState(0);
			useEffect(() => { props.subscribe(() => bump((n) => n + 1)); }, []);
			const c = layer.counters;
			const probe = layer.scanRoots();
			const rows = Object.values(layer.state);
			const totalRoots = rows.reduce((a, s) => a + (s.roots || 0), 0);
			return h("div", { className: "dct-panel", "data-dct-ignore": "", dir: "rtl", lang: "ar" },
				h("div", { className: "dct-title" }, "ترجمة المحتوى — Translate This"),
				h("div", { className: "dct-note" }, props.engine.label),
				layer.loopFlag ? h("div", { className: "dct-bad" }, "حلقة مشتبهة: أُوقفت الطبقة (أكثر من 300 حقن في ثانية).") : null,
				layer.debug ? h("div", { className: "dct-bad" }, layer.debug) : null,
				h("div", { className: "dct-sec" },
					h("div", { className: "dct-kv" }, h("span", null, "الأسطح المُعلَنة"), h("b", null, totalRoots === 0 ? "0 — لا سطح مطابق" : totalRoots + " مستهدف")),
					totalRoots === 0 ? h("div", { className: "dct-note dct-warn" },
						"لا سطح واحد مطابق الآن: المُحدِّدات لم تُقَس بعد على واجهة حيّة، وهذا ما يقيسه هذا السطر.") : null,
					...rows.map((s) => h("div", { className: "dct-row", key: s.id },
						h("label", null, h("input", {
							type: "checkbox", checked: !!s.on, "data-dct-ignore": "",
							onChange: (e) => layer.setSurface(s.id, e.target.checked)
						}), " " + s.label),
						h("b", null, (s.roots || 0) + (s.trust === "untrusted" ? " · غير موثوق" : ""))
					))
				),
				h("div", { className: "dct-sec" },
					h("div", { className: "dct-kv" }, h("span", null, "طلبات المحرّك"), h("b", null, c.requests)),
					h("div", { className: "dct-kv" }, h("span", null, "حقن"), h("b", null, c.injections)),
					h("div", { className: "dct-kv" }, h("span", null, "إعادة حقن من الكاش (بلا كلفة)"), h("b", null, c.reinjections)),
					h("div", { className: "dct-kv" }, h("span", null, "استسلام (حلقة)"), h("b", null, c.giveUps)),
					h("div", { className: "dct-kv" }, h("span", null, "نتائج متأخرة مُهمَلة"), h("b", null, c.droppedLate)),
					h("div", { className: "dct-kv" }, h("span", null, "وميض إنجليزي"), h("b", null, Math.round(c.flickerMs) + " ms")),
					h("div", { className: "dct-kv" }, h("span", null, "مخالفات شبكة"), h("b", null, c.network))
				),
				h("div", { className: "dct-actions" },
					button("ترجم هذا المحتوى", () => layer.translateRoots()),
					button("إلغاء", () => layer.cancel()),
					button("استرجاع الأصل", () => layer.restoreAll()),
					button("تفريغ الكاش", () => layer.clearCache()),
					props.onClose ? button("إغلاق", () => props.onClose()) : null
				),
				h("div", { className: "dct-note dct-sec" },
					"0.5 يحقن بما أُثبت في صفحة القبول؛ نداء النموذج (ctx.llm.stream) هو 0.6. الكاش بالمحتوى، " +
					"والأسطح غير الموثوقة بلا كاش، والسجلّات ميتاداتا فقط — لا نصّ خام.")
			);
		}

		/** The header action: the one button the user pressed a decision to get. */
		function HeaderAction(props) {
			const [open, setOpen] = useState(false);
			return h("span", { style: { display: "inline-flex", gap: 6, alignItems: "center" } },
				button("ترجم هذا المحتوى", () => { props.layer.translateRoots(); setOpen(true); }, { title: "ترجمة المحتوى المعروض عند الطلب" }),
				open ? h(Panel, { layer: props.layer, engine: props.engine, subscribe: props.subscribe, onClose: () => setOpen(false) }) : null
			);
		}

		/* ==================================================================== *
		 * 5. wiring
		 * ==================================================================== */

		const inject = ["slots"];

		function apply(ctx) {
			const warn = (label, error) => {
				try { console.warn("[dsh-translate-this] " + label + " degraded: " + String((error && error.message) || error)); } catch { /* noop */ }
			};
			const safe = (label, fn) => { try { return fn(); } catch (error) { warn(label, error); return undefined; } };

			const listeners = new Set();
			const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
			const layer = createLayer({ engine: stubEngine, onChange: () => { for (const fn of listeners) { try { fn(); } catch { /* noop */ } } } });

			safe("style", () => {
				const style = document.createElement("style");
				style.textContent = STYLE;
				style.dataset.dctStyle = "";
				document.head.appendChild(style);
			});
			safe("first scan", () => layer.scanRoots());

			// Native seats when the client runtime offers them (0.2+); a DOM-level dock
			// otherwise, so the button exists either way. Both are marked data-dct-ignore.
			let native = false;
			safe("slots:conversation.session.header.actions", () => {
				if (!ctx.slots || typeof ctx.slots.inject !== "function") return;
				ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
					name: "conversation.session.header.actions",
					id: "translate-this",
					order: 40
				}, (props) => h(HeaderAction, { layer, engine: stubEngine, subscribe })));
				native = true;
			});

			let dock = null;
			if (!native) {
				safe("dock", () => {
					dock = document.createElement("div");
					dock.setAttribute("data-dct-ignore", "");
					dock.style.cssText = "position:fixed;inset-block-start:12px;inset-inline-end:12px;z-index:999998";
					document.body.appendChild(dock);
					createRoot(dock).render(h(HeaderAction, { layer, engine: stubEngine, subscribe }));
				});
			}

			ctx.effect(() => () => {
				safe("dispose layer", () => layer.dispose());
				safe("dispose dock", () => { if (dock) { createRoot(dock).unmount?.(); dock.remove(); } });
			}, "dsh-translate-this: layer + ui");

			// A diagnostic handle: the layer is the product here, and a DOM injector that
			// cannot be inspected from the console is a DOM injector nobody can verify.
			safe("debug handle", () => { window.__dshTranslateThis__ = { layer, engine: stubEngine, version: "0.5.0" }; });
		}

		exports.apply = apply;
		exports.inject = inject;
		/* The layer is the product's core and the acceptance page is its harness, so the
		   harness builds the very same layer object the GUI builds — one source, nothing
		   to drift. The UI above is deliberately NOT exported: a harness that drove React
		   would be testing the shell instead of the layer. */
		exports.createLayer = createLayer;
		exports.SURFACES = SURFACES;
		exports.stubEngine = stubEngine;
		return module.exports;
	}
});
