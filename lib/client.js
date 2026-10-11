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
		 * `source` says where a root comes from, and that distinction was earned:
		 *   - **slot**: React hands us the node through one of its own seats. We mark the
		 *     ancestor that owns the prose. No class name is involved, so a CSS-Modules
		 *     hash cannot break it — which is the failure this project already documented
		 *     once (`dsh-arabic` shipped months of selectors that could never match
		 *     `_sweep_1rdzk_34`; text-level tests never noticed).
		 *   - **selector**: a declared allowlist for surfaces that give us no seat (other
		 *     plugins' panels, file previews, settings). Those stay `verified: false`
		 *     until measured on a live GUI — and the panel reports how many roots each one
		 *     actually found, so a wrong selector shows up as "0", never as silence.
		 */
		/**
		 * Selector note, learned from a live probe of the app shell: this UI is built with
		 * hashed class names of the form `<hash>_<semanticName>` — `BynINW_frame`,
		 * `Dc7zOa_composerSeat`, `KuQXFq_message`. So `[class*="_message_"]`, with the
		 * trailing underscore, can never match anything, while `[class*="_message"]` can.
		 * Where the shell offers an unhashed marker, prefer it: `data-conversation-*`,
		 * `data-dockkit-pane`, `data-sidebar-right-panel` are the markers the app itself
		 * uses to find its own regions, and no build step can rename them.
		 */
		/**
		 * Surface roots, all of them MEASURED on a live GUI. Two of these were seats first and
		 * had to be given up: `conversation.chat.node` and `tool.call.toolview` are *keyed*
		 * slots — the shell answers `Error: keyed slot "…" requires options.key`, and the keys
		 * are its own vocabulary (`user`, `steering`, …), not something a guest may invent.
		 * Inventing one would have been a silent no-op with a nice comment on it.
		 *
		 * What replaced them is better anyway: the shell's own unhashed markers. A CSS-module
		 * hash cannot break `data-conversation-content`, and the measurement agrees (roots 1 on
		 * a loaded conversation, 0 on an empty one — which is the correct answer, not a failure).
		 */
		const SURFACES = [
			{ id: "replies",  label: "نصّ الردود",       selector: "[data-conversation-content], [data-conversation-scroll]", on: true,  trust: "stable",    verified: true },
			{ id: "tools",    label: "مخرجات الأدوات",   selector: "[class*=\"_toolCallPayload\"], [class*=\"_toolCallOnly\"], [class*=\"_toolCall\"]", on: false, trust: "untrusted", verified: false },
			{ id: "files",    label: "معاينات الملفات",  selector: "[class*=\"_documentPreview\"], [data-sidebar-right-document]", on: false, trust: "stable", verified: false },
			{ id: "panels",   label: "لوحات البلاقنات",  selector: "[data-dockkit-pane], [data-sidebar-right-panel]", on: false, trust: "untrusted", verified: true },
			{ id: "settings", label: "الإعدادات",        selector: "[role=\"dialog\"]",                             on: false, trust: "chrome",    verified: true }
		];

		const IGNORE = "[data-dct-ignore]";
		const MARK = "data-dct-mark";                 // our own marker: direction lives in CSS, not inline
		const SURFACE_ATTR = "data-dct-surface";      // value = surface id, so `closest()` also answers "which one"
		const SURFACE_FROM = "data-dct-surface-from"; // value = slot | selector | fallback: provenance, shown in the panel
		const FRAME_FALLBACK_MS = 32;
		const GIVE_UP_MS = 10000;

		/**
		 * PLAN.md §6.4 in numbers.
		 *
		 * `SETTLE_MS` is rule 2 of §5 — "no block is translated before its text settles, and
		 * never a streaming one" — declared in 0.5 and, until this version, NOT implemented:
		 * the layer translated mid-stream and paid for it twice, once in tokens and once in a
		 * translation of half a sentence. The clock starts when the app last wrote the node
		 * (or when we first saw it), and content that keeps moving is never translated at all.
		 *
		 * The live/ephemeral rule is a BURST rule, not a "changed twice" rule, and that
		 * distinction was measured rather than assumed: with "two distinct values inside two
		 * seconds", a block the user simply edited twice — 1.5 s apart, the most ordinary thing
		 * in a chat — was classified live and refused translation (acceptance check 7 caught it:
		 * «بعد تغيير جملة: نداءات=0 مقاطع=0»). A counter is not a block that changed once more
		 * later; it is a block that keeps changing RIGHT NOW. So: three distinct values in two
		 * seconds, or two inside a 700 ms burst.
		 *
		 * Distinct values, not writes, again: an app that rewrites the SAME text over our
		 * translation is the flicker case, not a live counter.
		 */
		const SETTLE_MS = 500;
		const VOLATILE_WINDOW_MS = 2000;
		const VOLATILE_HITS = 3;
		const VOLATILE_BURST_MS = 700;
		const MAX_DEFERRALS = 6;      // a node that never settles stops being deferred (and is counted)

		/**
		 * Words that may appear in a live readout. Everything else means "this is prose".
		 * Deliberately small and boring: the first-sight test only fires when a text has a
		 * digit AND every letter-run in it is one of these, so a line like "log line 3: device
		 * connected" is prose (words are unknown) while "12,345 tokens · 3.2 s" is a counter.
		 */
		const COUNTER_WORDS = new Set([
			"ms", "s", "m", "h", "d", "sec", "secs", "min", "mins", "hr", "hrs", "x", "of", "in", "out",
			"kb", "mb", "gb", "tb", "b", "k", "tok", "toks", "token", "tokens", "fps", "rpm", "qps",
			"req", "reqs", "count", "total", "ago", "now", "active", "idle", "v", "es", "bytes", "byte",
			"ث", "ثا", "ثانية", "ثانيتين", "ثوان", "ثوانٍ", "دقيقة", "دقائق", "ساعة", "ساعات", "يوم", "أيام",
			"مدة", "منذ", "قبل", "الآن", "طلب", "طلبات", "توكن", "توكنز", "رمز", "رموز", "بايت", "كيلوبايت", "ميجابايت"
		]);

		/** Is the text nothing but numbers, units and separators? Then it is a readout, not prose. */
		function looksLikeReadout(text) {
			const s = String(text ?? "").trim();
			if (s === "" || s.length > 64) return false;
			if (!/\d/.test(s)) return false;
			const runs = s.match(/[A-Za-z\u0600-\u06FF]+/g) || [];
			if (runs.length > 5) return false;
			// A unit followed by a slash ("kb/s") is still a unit.
			return runs.every((w) => COUNTER_WORDS.has(w.toLowerCase()) || w.split("/").every((p) => p === "" || COUNTER_WORDS.has(p.toLowerCase())));
		}

		/* ==================================================================== *
		 * 2. the layer (ported from the acceptance page, verified there)
		 * ==================================================================== */

		/**
		 * Target language. It is NOT read from the interface language pack: translating the
		 * interface is `dsh-arabic`'s job, and coupling the two would make one plugin's
		 * setting silently change another's behaviour. The choice lives here, is shown in the
		 * panel, persists locally, rides in the cache key (so switching re-translates instead
		 * of showing the previous language) and travels with every request to the host.
		 */
		const TARGETS = [
			{ code: "ar", label: "العربية" },
			{ code: "en", label: "English" },
			{ code: "fr", label: "Français" },
			{ code: "zh", label: "中文" },
			{ code: "tr", label: "Türkçe" }
		];
		const ENGINE_STATE = {
			target: (() => { try { return localStorage.getItem("dct-target") || "ar" } catch { return "ar" } })()
		};
		const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
		const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

		/* ==================================================================== *
		 * 2b. segments — the unit 0.6 caches on (PLAN.md §6.1 · §6.4)
		 * ==================================================================== */

		/** Terminators of both scripts: a splitter that only knows "." hands a whole Arabic paragraph to one call. */
		const TERMINATORS = ".!?…؟";
		/** Shorter than this and a piece is glued forward: "OK." alone is not worth a line in a batch. */
		const MIN_SEGMENT_CHARS = 12;
		/** Longer than this and a piece is cut at a space: a batch has a ceiling and one endless paragraph must not break it. */
		const MAX_SEGMENT_CHARS = 600;
		/** The client's batch ceiling. The host enforces a wider one of its own and refuses politely. */
		const BATCH_SEGMENTS = 8;
		const BATCH_CHARS = 1800;

		/**
		 * Cut text into sentences while KEEPING every character — `splitSegments(t).join("") === t`.
		 * That invariant is the whole design: the pieces are translated separately and glued back
		 * with their own separators, so a translation is a substitution, never a re-flow of the
		 * user's layout (PLAN.md §6.1). If any cut would lose or reorder a byte, the splitter
		 * gives up and returns the text as ONE segment: an unbatched call is slower, a lossy
		 * split is wrong.
		 *
		 * Two things are never split: a `` `code span` `` and anything inside brackets — a
		 * sentence terminator in `README.md` or `npx @deepseek-ai/dsh` (the URLs in the fixtures)
		 * is not the end of a sentence.
		 *
		 * Exported: `acceptance/protocol.mjs` feeds it text and checks the invariant, because a
		 * splitter that quietly drops a byte would corrupt every translation built on it.
		 */
		function splitSegments(text) {
			const s = String(text ?? "");
			if (s.length <= MIN_SEGMENT_CHARS) return s === "" ? [] : [s];
			const raw = [];
			let start = 0;
			let i = 0;
			let tick = false;      // inside `code`
			let depth = 0;         // inside (…) or […]
			while (i < s.length) {
				const ch = s[i];
				if (ch === "`") { tick = !tick; i += 1; continue; }
				if (tick) { i += 1; continue; }
				if (ch === "(" || ch === "[") { depth += 1; i += 1; continue; }
				if (ch === ")" || ch === "]") { depth = Math.max(0, depth - 1); i += 1; continue; }
				if (depth === 0 && TERMINATORS.indexOf(ch) !== -1) {
					let j = i + 1;
					while (j < s.length && (TERMINATORS.indexOf(s[j]) !== -1 || s[j] === '"' || s[j] === "'" || s[j] === "»" || s[j] === "\u201d")) j += 1;
					if (j >= s.length || /\s/.test(s[j])) {
						let k = j;
						while (k < s.length && /\s/.test(s[k])) k += 1;
						raw.push(s.slice(start, k));       // the piece keeps its own terminator AND its spacing
						start = k;
						i = k;
						continue;
					}
				}
				i += 1;
			}
			if (start < s.length) raw.push(s.slice(start));
			// A fragment is glued onto a NEIGHBOUR, in both directions: a short tail ("Really?")
			// onto what precedes it, a short head ("OK. ") onto what follows. A seven-character
			// segment spends a slot in a batch and gives the model no context to translate well.
			const merged = [];
			for (const piece of raw) {
				if (merged.length && piece.replace(/\s+$/, "").length < MIN_SEGMENT_CHARS) { merged[merged.length - 1] += piece; continue; }
				merged.push(piece);
			}
			if (merged.length > 1 && merged[0].replace(/\s+$/, "").length < MIN_SEGMENT_CHARS) {
				merged[1] = merged[0] + merged[1];
				merged.shift();
			}
			const capped = [];
			for (const piece of merged) {
				let rest = piece;
				while (rest.length > MAX_SEGMENT_CHARS) {
					const cut = rest.lastIndexOf(" ", MAX_SEGMENT_CHARS);
					const at = cut > MIN_SEGMENT_CHARS ? cut + 1 : MAX_SEGMENT_CHARS;
					capped.push(rest.slice(0, at));
					rest = rest.slice(at);
				}
				if (rest !== "") capped.push(rest);
			}
			return capped.join("") === s ? capped : [s];
		}

		/**
		 * Glue translated pieces back into one string, each piece keeping the spacing it was
		 * split with. `translations[i] == null` means "this piece was never translated" (a piece
		 * of pure whitespace): it is copied, not invented.
		 */
		function composeSegments(pieces, translations) {
			let out = "";
			for (let i = 0; i < pieces.length; i += 1) {
				const piece = pieces[i];
				const t = translations[i];
				if (t === undefined || t === null) { out += piece; continue; }
				const trail = (piece.match(/\s+$/) || [""])[0];
				out += String(t).replace(/^\s+/, "").replace(/\s+$/, "") + trail;
			}
			return out;
		}

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
				cache: new Map(),          // BLOCK key -> composed translation (PLAN.md §6.2)
				segments: new Map(),       // SEGMENT key -> translation: the unit 0.6 caches on
				segPending: new Map(),     // segment key -> { key, text, waiters }: the batch queue
				segTimer: null,            // one dispatch per tick, never one per segment
				records: new Map(),        // text node -> { source, translation, key, gen, host, surface }
				hosts: new Map(),          // parent element -> { source, key, surface }: survives a node swap
				queue: [],
				held: new Map(),           // key -> { count, until }: the give-up rule
				gen: 0,
				pending: false,
				loopFlag: false,
				enabled: true,
				rate: [],
				target: ENGINE_STATE.target,   // the language the cache key is built on
				inflight: 0,                // engine CALLS in flight (a batch is one call), for the spinner
				blocksWaiting: 0,           // blocks waiting on segments: separates "queued" from "called"
				diagnostics: [],            // visible failures: a surface that found nothing says so
				debug: null,               // last failure, shown in the panel rather than swallowed
				lastWrite: new Map(),       // node -> when the app last wrote it: the settle window
				writes: new Map(),          // node -> [timestamps of DISTINCT values]: the live/ephemeral rule
				lastValue: new Map(),       // node -> last distinct value seen (so a rewrite of the SAME text is not "volatility")
				volatile: new Set(),        // nodes classified live/ephemeral: never translated (§6.4)
				volatileNoted: new Set(),   // counted once in the panel, not once per pass
				deferrals: new Map(),       // node -> how many times it was deferred for settling
				counters: { requests: 0, injections: 0, reinjections: 0, giveUps: 0, droppedLate: 0,
				            flickerMs: 0, network: 0, englishSince: new Map(),
				            // 0.6 part two: the cost counter's inputs. Every one of them is moved by a
				            // measured event (a call, a segment, a cache hit, a refused batch), never by a guess.
				            batchCalls: 0, segmentsRequested: 0, segmentHits: 0, blocks: 0,
				            failedBatches: 0, alignmentFailures: 0, volatileSkipped: 0, settleDeferrals: 0,
				            usageCalls: 0, usageUnknown: 0, tokensIn: 0, tokensOut: 0,
				            cacheReadTokens: 0, cacheWriteTokens: 0, lastCallMs: 0, lastUsage: null }
			};

			/**
			 * The content key (PLAN.md §6.2): the text plus everything that would make a stored
			 * translation WRONG if it changed — the target language, the model that produced it,
			 * and the prompt version. It never contains a DOM id or a position, so a node that
			 * moves keeps its translation and a node that is recycled for other text loses it.
			 */
			const keyOf = (text) => [
				L.target,
				ENGINE_STATE.model || "?",
				ENGINE_STATE.promptVersion || "batch-v1",
				"v1",
				text
			].join("\u0001");

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

			/* ---- what the app is doing to a node: settling, or churning (PLAN.md §6.4) ---- */

			/**
			 * Record that the app wrote a node. Called from the observer's READ path only — it
			 * touches Maps and never the DOM, so rule 2 (the observer callback never writes)
			 * holds: this is bookkeeping about a record already in hand.
			 *
			 * A write of the SAME value the node already had is not evidence of a live counter:
			 * the flicker case (an app rewriting the original over our translation) would
			 * otherwise mark every re-rendered block as live and stop translating it — and that
			 * case is the one the acceptance page drives twice on purpose.
			 */
			function noteWrite(node, value) {
				const t = now();
				L.lastWrite.set(node, t);
				const seen = L.lastValue.get(node);
				if (seen === value) return;
				L.lastValue.set(node, value);
				const recent = (L.writes.get(node) || []).filter((x) => t - x < VOLATILE_WINDOW_MS);
				recent.push(t);
				L.writes.set(node, recent.slice(-6));
				const burst = recent.filter((x) => t - x < VOLATILE_BURST_MS).length;
				if ((recent.length >= VOLATILE_HITS || burst >= 2) && !L.volatile.has(node)) L.volatile.add(node);
			}

			/** Live/ephemeral: it churned, or nothing but digits and units came into view. */
			function isVolatile(node, text) {
				if (L.volatile.has(node)) return true;
				if (text !== undefined && looksLikeReadout(text)) { L.volatile.add(node); return true; }
				return false;
			}

			/** Count a skip once per node: the panel's number means "nodes refused", not "passes made". */
			function noteVolatile(node) {
				if (L.volatileNoted.has(node)) return;
				L.volatileNoted.add(node);
				L.counters.volatileSkipped += 1;
				notify();
			}

			/**
			 * Wait out the rest of the settle window, then look again. A timer, never a write;
			 * and bounded, so content that never settles stops costing passes (it is then
			 * classified live and skipped — visible in the panel, not silent).
			 */
			function deferRequest(node, waitMs) {
				const n = (L.deferrals.get(node) || 0) + 1;
				L.deferrals.set(node, n);
				if (n > MAX_DEFERRALS) { L.volatile.add(node); noteVolatile(node); return; }
				L.counters.settleDeferrals += 1;
				setTimeout(() => { if (L.enabled) schedule(node); }, Math.max(16, Math.min(SETTLE_MS, Math.ceil(waitMs))));
			}

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

			/* ---- batching: N segments in one call, one dispatch per tick ---- */

			/**
			 * Ask for one segment. Identical segments coalesce here — the same sentence in two
			 * replies is one request — and the dispatch is deferred to a timer, so a click that
			 * schedules forty blocks produces batches instead of forty calls.
			 */
			function ensureSegment(item) {
				return new Promise((resolve, reject) => {
					if (L.segments.has(item.key)) return resolve(true);
					let entry = L.segPending.get(item.key);
					if (!entry) { entry = { key: item.key, text: item.text, waiters: [] }; L.segPending.set(item.key, entry); }
					entry.waiters.push({ resolve, reject });
					if (!L.segTimer) L.segTimer = setTimeout(() => { L.segTimer = null; dispatchSegments(); }, 0);
				});
			}

			/** Group the pending segments into calls that respect both ceilings, then send them. */
			function dispatchSegments() {
				const entries = Array.from(L.segPending.values());
				L.segPending.clear();
				let batch = [];
				let chars = 0;
				for (const entry of entries) {
					if (batch.length && (batch.length >= BATCH_SEGMENTS || chars + entry.text.length > BATCH_CHARS)) {
						runBatch(batch);
						batch = [];
						chars = 0;
					}
					batch.push(entry);
					chars += entry.text.length;
				}
				if (batch.length) runBatch(batch);
			}

			/**
			 * One engine call for a batch of segments. This is where 0.6 part two's contract is
			 * kept: the answer must carry exactly as many segments as were sent, or the WHOLE
			 * batch is thrown away — nothing enters the segment cache, every waiter is
			 * rejected, and the panel gets a red line naming the failure. A half-aligned batch
			 * stored under keys that promise alignment is worse than no translation at all.
			 */
			async function runBatch(entries) {
				const texts = entries.map((e) => e.text);
				L.counters.requests += 1;                 // the unit is a CALL now, not a block: this is the cost counter
				L.counters.batchCalls += 1;
				L.counters.segmentsRequested += texts.length;
				L.inflight += 1;                          // the spinner's whole reason to exist
				notify();
				try {
					if (typeof engine.translateBatch !== "function") {
						const e = new Error("المحرّك لا يعرف الدفعات (translateBatch مفقود)");
						e.code = "NO_BATCH";
						throw e;
					}
					const payload = await engine.translateBatch(texts, { target: L.target });
					const list = payload && Array.isArray(payload.segments) ? payload.segments : null;
					if (!list || list.length !== texts.length) {
						const e = new Error("محاذاة الدفعة فشلت: أُعيد " + (list ? list.length : "لا شيء") + " من " + texts.length);
						e.code = "ALIGNMENT_FAILED";
						throw e;
					}
					for (let i = 0; i < entries.length; i += 1) L.segments.set(entries[i].key, String(list[i]));
					if (payload.usage) {
						// The field names are MEASURED, not assumed: a live call on the test host
						// reported `usageKeys: ["inputTokens","outputTokens","cacheReadTokens",
						// "cacheWriteTokens","totalTokens"]`, and the type definitions say the
						// counts are DISJOINT — `inputTokens` is uncached input only, so billed
						// input is the sum of the three. A counter showing `inputTokens` alone
						// under-reports every cached call (measured: 251 shown, 379 billed).
						const u = payload.usage;
						const read = Number(u.cacheReadTokens) || 0;
						const write = Number(u.cacheWriteTokens) || 0;
						L.counters.usageCalls += 1;
						L.counters.lastUsage = u;
						L.counters.tokensIn += (Number(u.inputTokens) || 0) + read + write;
						L.counters.tokensOut += Number(u.outputTokens) || 0;
						L.counters.cacheReadTokens += read;
						L.counters.cacheWriteTokens += write;
					} else {
						L.counters.usageUnknown += 1;         // shown as "unknown", never as a zero we invented
					}
					if (typeof payload.ms === "number") L.counters.lastCallMs = payload.ms;
					for (const entry of entries) {
						const waiters = entry.waiters;
						entry.waiters = [];
						for (const w of waiters) w.resolve(true);
					}
				} catch (error) {
					const code = String((error && error.code) || (error && error.name) || "TRANSPORT");
					L.counters.failedBatches += 1;
					if (code === "ALIGNMENT_FAILED") L.counters.alignmentFailures += 1;
					L.debug = "فشل المحرّك (" + code + "): " + String((error && error.message) || error);
					for (const entry of entries) {
						const waiters = entry.waiters;
						entry.waiters = [];
						for (const w of waiters) w.reject(error);
					}
				} finally {
					L.inflight -= 1;
					notify();
				}
			}

			/**
			 * Translate one block: block cache first, then the segments it is made of, then one
			 * call per batch of missing segments. Injection waits for the WHOLE block — half a
			 * block in Arabic and half in English is not a state this project ships — but every
			 * segment is stored on its own, so the next block sharing a sentence pays zero.
			 */
			async function request(node, surfaceId) {
				const source = norm(node.nodeValue || "");
				const key = keyOf(source);
				const gen = L.gen;
				const cached = L.cache.get(key);
				if (cached !== undefined) { inject(node, cached, surfaceId); return; }
				const hold = L.held.get(key);
				if (hold && now() < hold.until) return;                  // we stopped fighting this key
				// §5 rule 2 / §6.4: never translate a block that is still being written.
				const quiet = now() - (L.lastWrite.get(node) ?? 0);
				if (quiet < SETTLE_MS) { deferRequest(node, SETTLE_MS - quiet); return; }
				if (isVolatile(node, source)) { noteVolatile(node); return; }

				const pieces = splitSegments(source);
				const items = pieces.map((piece) => {
					const text = piece.trim();
					return { piece, text, key: text === "" ? null : keyOf(text) };
				});
				const missing = [];
				for (const item of items) {
					if (item.key === null) continue;                     // pure spacing: copied, never sent
					if (L.segments.has(item.key)) { L.counters.segmentHits += 1; continue; }
					missing.push(item);
				}
				L.counters.blocks += 1;
				L.blocksWaiting += 1;
				notify();
				try {
					if (missing.length) {
						// allSettled, not all: one rejected batch must not leave the other promises
						// unhandled, and every one of them carries the same "nothing was stored" meaning.
						const settled = await Promise.allSettled(missing.map((item) => ensureSegment(item)));
						const bad = settled.find((r) => r.status === "rejected");
						if (bad) throw bad.reason;
					}
					if (gen !== L.gen) { L.counters.droppedLate += 1; notify(); return; }
					if (!node.isConnected) return;
					if (norm(node.nodeValue || "") !== source) { L.counters.droppedLate += 1; return; }
					const translations = items.map((item) => (item.key === null ? null : L.segments.get(item.key)));
					if (translations.some((t, i) => t === undefined && items[i].key !== null)) {
						const e = new Error("مقطع مفقود عند التركيب — لا حقن جزئي");
						e.code = "PARTIAL";
						throw e;
					}
					const composed = composeSegments(pieces, translations);
					L.cache.set(key, composed);
					inject(node, composed, surfaceId);
				} catch (error) {
					L.debug = "فشل المحرّك: " + String((error && error.message) || error);
				} finally {
					L.blocksWaiting -= 1;
					notify();
				}
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
						const value = norm(r.target.nodeValue || "");
						const rec = L.records.get(r.target);
						if (rec && value === rec.translation) continue;               // the app wrote our own text back
						// Bookkeeping only (no DOM write): this is how the settle window and the
						// live/ephemeral rule learn that the app is still writing this node.
						noteWrite(r.target, value);
						if (!rec) continue;
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
						if (added.nodeType === 3) { noteWrite(added, norm(added.nodeValue || "")); repair(added); continue; }
						if (added.nodeType !== 1) continue;
						const inner = [];
						textNodesIn(added, inner, 50);
						for (const t of inner) { noteWrite(t, norm(t.nodeValue || "")); repair(t); }
					}
				}
				if (rootsMayHaveChanged && !L.pending) {
					L.pending = true;
					nextFrame(() => { L.pending = false; scanRoots(); notify(); });
				}
			});
			observer.observe(document.body, { childList: true, subtree: true, characterData: true });

			/* ---- surface discovery: mark the roots we are allowed to work in ---- */
			/**
			 * Mark a root React handed us through one of its seats. The count is derived
			 * from the document afterwards, never from our own bookkeeping: a root that
			 * unmounts must stop being counted, and a count we maintain by hand is a count
			 * that can lie.
			 */
			function markSurface(el, id) {
				if (!L.state[id]) return false;
				L.state[id].markers = (L.state[id].markers || 0) + 1;
				if (!el) {
					note("فتحة " + id + ": العلامة رُكّبت ولم أجد جدًّا يحمل نثرًا فوقها");
					return false;
				}
				if (el.closest && el.closest(IGNORE)) return false;
				if (el.getAttribute(SURFACE_ATTR) === id) return true;
				// Attribute-only writes on our own marker: not observed, so not muted (see
				// markBySelector — `takeRecords()` there would swallow the app's pending writes).
				el.setAttribute(SURFACE_ATTR, id); el.setAttribute(SURFACE_FROM, "slot");
				return true;
			}

			/**
			 * A surface that finds nothing must say so in the panel. This exists because the
			 * first injection mounted, translated nothing, and reported nothing: the slot
			 * registration had failed into a `console.warn` nobody reads — a silent no-op,
			 * which is the one failure mode this project does not accept.
			 */
			function note(message) {
				L.diagnostics.push(message);
				if (L.diagnostics.length > 8) L.diagnostics.shift();
				notify();
			}

			/**
			 * What is this DOM actually made of? A short, copyable census of the candidate
			 * containers, so ONE panel screenshot answers every "is it the seat, the selector,
			 * or the DOM?" question at once — instead of one round trip per hypothesis.
			 * Zeros are reported too: what is absent is a measurement.
			 */
			const DISCOVERY = [
				"[data-conversation-content]", "[data-conversation-scroll]", "[data-conversation-region]",
				"[class*=\"_markdownPayload\"]", "[class*=\"_message\"]", "[class*=\"_toolCallPayload\"]",
				"[class*=\"_documentPreview\"]", "[data-dockkit-pane]", "[data-sidebar-right-panel]"
			];
			function discover() {
				const parts = [];
				for (const sel of DISCOVERY) {
					let n = -1;
					try { n = document.querySelectorAll(sel).length } catch { /* malformed selector: report -1 */ }
					parts.push(sel.replace('[class*="', "").replace('"]', "").replace(/[[\]]/g, "") + "=" + n);
				}
				return parts;
			}

			/**
			 * Mark everything a selector list matches, remembering WHERE the root came from.
			 *
			 * No `muted()` here, and that is deliberate: these are ATTRIBUTE writes on our own
			 * `data-dct-*` markers, and the observer watches `childList` + `characterData` only —
			 * attribute writes produce no records at all. Wrapping them in `muted()` would run
			 * `observer.takeRecords()`, which DISCARDS every record still queued — including a
			 * write the app made in the same task. Measured: a click right after the app wrote a
			 * block (both in one task) lost that write's record, so `lastWrite` stayed unset and
			 * the settle window was skipped — the streaming rule failed open, silently.
			 */
			function markBySelector(s, selector, origin) {
				let n = 0;
				for (const el of document.querySelectorAll(selector)) {
					if (el.closest(IGNORE)) continue;
					if (el.getAttribute(SURFACE_ATTR) === s.id) { n += 1; continue }
					const owner = el.closest("[" + SURFACE_ATTR + "]");       // keep the innermost
					if (owner && owner !== el) continue;
					el.setAttribute(SURFACE_ATTR, s.id);
					el.setAttribute(SURFACE_FROM, origin);
					n += 1;
				}
				return n;
			}

			function scanRoots() {
				for (const s of Object.values(L.state)) {
					if (!s.selector) continue;
					const primary = markBySelector(s, s.selector, "selector");
					// A declared fallback runs only when the primary tier found nothing, so a
					// fallback that fired stays visible as a fallback.
					if (primary === 0 && s.fallback) markBySelector(s, s.fallback, "fallback");
				}
				// Count what is actually marked, and label the tier from PROVENANCE — never from
				// "something is there". The first version called a fallback-marked root a "slot"
				// and handed the panel a comfortable lie.
				let total = 0;
				for (const s of Object.values(L.state)) {
					const all = document.querySelectorAll("[" + SURFACE_ATTR + '="' + s.id + '"]');
					s.roots = all.length;
					s.slotRoots = 0; s.selectorRoots = 0; s.fallbackRoots = 0;
					for (const el of all) {
						const from = el.getAttribute(SURFACE_FROM);
						if (from === "slot") s.slotRoots += 1;
						else if (from === "fallback") s.fallbackRoots += 1;
						else s.selectorRoots += 1;
					}
					s.tier = s.slotRoots ? "slot" : (s.selectorRoots ? "selector" : (s.fallbackRoots ? "fallback" : "none"));
					total += s.roots;
				}
				return total;
			}

			/* ---- public operations ---- */
			/**
			 * Translate the roots that are MARKED, not the roots a selector would match.
			 *
			 * This was wrong in the first build, and only a live measurement caught it: the
			 * surfaces that actually work here are the ones React's seats declare (the
			 * settings page, the conversation content), while a selector only ever marked
			 * plugin panels. So a click scheduled nothing while the panel cheerfully reported
			 * "1 target". `eligible()` already worked off the marked roots; now the enqueue
			 * side does too, which is the whole point of declaring a surface at all.
			 */
			function translateRoots(ids) {
				const wanted = ids ? [].concat(ids) : Object.values(L.state).filter((s) => s.on).map((s) => s.id);
				scanRoots();                                  // re-mark first, then read the marks
				let scheduled = 0;
				for (const id of wanted) {
					const s = L.state[id];
					if (!s || !s.on) continue;
					for (const el of document.querySelectorAll("[" + SURFACE_ATTR + '="' + id + '"]')) {
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

			/** Both caches: the block cache and the segment cache 0.6 stores on (§6.1). */
			function clearCache() { L.cache.clear(); L.segments.clear(); L.held.clear(); notify(); }

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

			/** Change the target language: the cache key changes with it, so nothing stale survives. */
			function setTarget(code) {
				const next = String(code || "ar").slice(0, 8);
				if (next === L.target) return;
				L.target = next;
				ENGINE_STATE.target = next;
				try { localStorage.setItem("dct-target", next) } catch { /* private mode: keep it for this page */ }
				restoreAll();                       // what is on screen belongs to the old language
				notify();
			}

			const api = {
				state: L.state, counters: L.counters, surfaces: table,
				get loopFlag() { return L.loopFlag }, get debug() { return L.debug },
				get diagnostics() { return L.diagnostics },
				get inflight() { return L.inflight },
				/** True while anything is queued, waiting on segments, or waiting on the engine — the spinner's input. */
				get busy() { return L.inflight > 0 || L.blocksWaiting > 0 || L.queue.length > 0 },
				/** True once this layer is holding translations: the button's second face. */
				get translated() { return L.records.size > 0 },
				get target() { return L.target },
				/** The segment cache, read-only from outside: what 0.6 caches on (§6.1). */
				get segments() { return L.segments },
				setTarget,
				translateRoots, restoreAll, restoreSurface, cancel, setSurface, clearCache,
				scanRoots, markSurface, note, discover, dispose,
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
		/** The plugin's own route on the host. Same origin, no third party, no extra key. */
		const ROUTE = "/dsh-translate-this"

		/**
		 * 0.6 engine: the HOST calls the model. The browser half only posts text to the
		 * plugin's own route and gets a translation back — the client never holds a
		 * credential, never picks a provider, and never talks to anything but this host.
		 *
		 * Every failure arrives as a named code and is shown in the panel: a missing model, a
		 * missing credential, a timeout, a transport failure. Nothing falls back silently to
		 * another service — that rule is the reason this object exists at all.
		 */
		function hostEngine(state) {
			return {
				kind: "host",
				label: "نموذج DSH — عبر ctx.llm.stream",
				/**
				 * One call, N segments (0.6 part two). The host owns the separator protocol and
				 * the alignment check; this side verifies the COUNT again — a contract checked
				 * only at one end is a contract with a silent hole — and returns the usage the
				 * host reported so the counter shows measured numbers or nothing at all.
				 */
				async translateBatch(texts, options) {
					let res
					try {
						res = await fetch(ROUTE + "/translate", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ segments: texts, target: (options && options.target) || state.target })
						})
					} catch (error) {
						const e = new Error("تعذّر الوصول إلى مسار المحرّك في المضيف")
						e.code = "TRANSPORT"
						throw e
					}
					const body = await res.json().catch(() => ({}))
					if (!res.ok || body && body.ok === false) {
						const code = (body && body.error && body.error.code) || ("HTTP " + res.status)
						const detail = body && body.error && body.error.message ? " — " + body.error.message : ""
						const e = new Error(code + detail)
						e.code = code
						throw e
					}
					const list = Array.isArray(body.segments) ? body.segments : (typeof body.text === "string" ? [body.text] : null)
					if (!list) {
						const e = new Error("ردّ المضيف بلا مقاطع")
						e.code = "EMPTY_REPLY"
						throw e
					}
					return { segments: list, usage: body.usage || null, ms: body.ms, model: body.model, diag: body.diag }
				},
				/** One text at a time: kept for the panel's own probes and for anything that speaks the old shape. */
				async translate(text) {
					const out = await hostEngine(state).translateBatch([text], { target: state.target })
					return String(out.segments[0] == null ? "" : out.segments[0])
				}
			}
		}

		const stubEngine = {
			kind: "stub",
			label: "محرّك ثابت (0.5) — لا نموذج ولا شبكة",
			translate(text) {
				return new Promise((resolve) => setTimeout(() => resolve("«ترجمة» " + text), 0));
			},
			async translateBatch(texts) {
				const segments = [];
				for (const t of texts) segments.push(await stubEngine.translate(t));
				return { segments, usage: null };
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
.dct-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 10px; }
.dct-actions .dct-btn { width: 100%; justify-content: center; margin: 0; }
.dct-actions .dct-wide { grid-column: 1 / -1; }
.dct-btn.dct-icon { width: 28px; padding: 0; justify-content: center; }
.dct-btn.dct-icon svg { display: block; }
.dct-btn.dct-mini { height: 22px; padding: 0 8px; font-size: 11px; }
.dct-settings-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; padding: 10px 0; }
.dct-settings-label { font-size: 13px; }
.dct-select { background: transparent; color: inherit; border: 1px solid rgba(128,128,128,.35);
  border-radius: 8px; padding: 2px 6px; font: inherit; font-size: 12px; }
.dct-spin { display: inline-block; width: 13px; height: 13px; border: 2px solid currentColor;
  border-top-color: transparent; border-radius: 50%; animation: dct-rot .8s linear infinite; }
@keyframes dct-rot { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .dct-spin { animation-duration: 2s; } }
[data-dct-mark] { unicode-bidi: isolate; }
`;

		function button(label, onClick, extra) {
			return h("button", Object.assign({ className: "dct-btn", type: "button", onClick, "data-dct-ignore": "" }, extra || {}), label);
		}

		/**
		 * The button's face: the owner asked for the icon instead of the sentence, and the
		 * sentence moved to the accessible name (`aria-label` + `title`), so the plan's
		 * locked label «ترجم هذا المحتوى» still names the action for screen readers, for
		 * hover, and for anyone reading the markup. Two boxes — the source glyph and the
		 * target letter — with the exchange between them.
		 *
		 * It is a function, not a module-level constant, and that is load-bearing: the
		 * acceptance harness drives the layer with no React at all (`require` returns
		 * nothing), so anything calling `h` while the module initialises takes the whole
		 * client half down before the layer exists. Rendering belongs at render time.
		 */
		function translateIcon() {
			return h("svg", {
				width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
				strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", focusable: "false"
			},
				h("rect", { x: 2.5, y: 3, width: 11, height: 10, rx: 2 }),
				h("path", { d: "M6 6.4h4.6M8.3 5.2v2.4M5.6 9.2l5 3.4M10.6 9.2l-5 3.4" }),
				h("rect", { x: 10.5, y: 11, width: 11, height: 10, rx: 2 }),
				h("path", { d: "M13.4 18.6l2.6-5.4 2.6 5.4M14.4 16.7h3.2" })
			);
		}

		/* ---- surfaces React hands us, instead of selectors we would have to guess ---- */

		/** The nearest ancestor that actually owns prose — the block we may translate. */
		function proseAncestor(start, maxLevels = 6) {
			let el = start;
			for (let i = 0; el && i < maxLevels; i += 1, el = el.parentElement) {
				if (el === document.body) break;
				if (el.querySelector && el.querySelector("p, li, h1, h2, h3, h4, h5, h6, blockquote, td")) return el;
			}
			return null;
		}

		/**
		 * A zero-size marker that exists only to learn where React put us. The shell gives
		 * it one seat per conversation node (and per tool view); from there we climb to the
		 * block that owns the prose and declare that block a surface. No class name, no
		 * hash, no guessing — and the panel probe still reports what was found, so a missing
		 * seat is a visible "0" rather than a silence.
		 */
		function SurfaceMarker(props) {
			const ref = useRef(null);
			useEffect(() => {
				// A marker that finds nothing is a measurement too — report it, never swallow it.
				props.layer.markSurface(proseAncestor(ref.current ? ref.current.parentElement : null), props.id);
			}, []);
			return h("span", { ref, "data-dct-ignore": "", style: { display: "none" } });
		}

		/**
		 * The container a page-like surface really is.
		 *
		 * Measured, not guessed: the settings window is a `[role="dialog"]`, and this UI has
		 * NO `h1/h2/h3` anywhere in that chain — so the first version, which climbed to the
		 * outermost ancestor holding a heading, fell back to the marker's parent and declared
		 * a 25-character toolbar as "the settings page". The owner saw the consequence: the
		 * translate button turned «فتح ملف الإعدادات» into «ترجمة فتح ملف الإعدادات» and
		 * nothing else happened.
		 *
		 * So: the dialog container first, then a heading if one exists, then the parent.
		 */
		function pageAncestor(start, id, maxLevels = 12) {
			if (!start) return null;
			const dialog = start.closest && start.closest('dialog, [role="dialog"]');
			if (dialog) return dialog;
			let el = start;
			let best = null;
			for (let i = 0; el && el !== document.body && i < maxLevels; i += 1, el = el.parentElement) {
				if (!el.querySelector || !el.querySelector("h1, h2, h3")) continue;
				// Never swallow another declared surface: if the climb reaches a container that
				// already holds a marked root (the conversation, say), it stops below it instead
				// of translating the whole app under the name "settings".
				const other = el.querySelector("[" + SURFACE_ATTR + ']:not([' + SURFACE_ATTR + '="' + id + '"])');
				if (!other) best = el;
			}
			return best || start;
		}

		/**
		 * The icon alone, for seats that are a toolbar rather than a list row — the settings
		 * window's own header. Same act as the row below it, placed where that window keeps
		 * its other actions, because that is where a hand looks for it.
		 */
		function SettingsIcon(props) {
			const ref = useRef(null);
			const busy = useBusy(props.layer, props.subscribe);
			const translated = props.layer.translated;
			useEffect(() => {
				// The header icon declares the page as well as translating it: the labelled row
				// lives in the General tab, and a surface must not depend on which tab is open.
				props.layer.markSurface(pageAncestor(ref.current ? ref.current.parentElement : null, "settings"), "settings");
			}, []);
			const act = () => {
				if (props.layer.translated) props.layer.restoreAll();
				else props.layer.setSurface("settings", true);
			};
			return h("span", { ref, "data-dct-ignore": "", style: { display: "inline-flex" } },
				button(busy ? h(Spinner) : translateIcon(), act, {
					className: "dct-btn dct-icon",
					"data-on": translated ? "1" : undefined,
					title: busy ? "جارٍ الترجمة…" : (translated ? "استرجاع الأصل" : "ترجم محتوى الإعدادات"),
					"aria-label": busy ? "جارٍ الترجمة" : (translated ? "استرجاع الأصل" : "ترجم محتوى الإعدادات")
				})
			);
		}

		/**
		 * The settings row. The owner's rule is that a surface's control lives IN that
		 * surface: this one sits inside the settings window, declares the settings page a
		 * surface from its own position (no selector to guess), and translates only that
		 * surface. The icon in the conversation header keeps covering everything.
		 */
		function SettingsRow(props) {
			const ref = useRef(null);
			const busy = useBusy(props.layer, props.subscribe);
			useEffect(() => {
				props.layer.markSurface(pageAncestor(ref.current ? ref.current.parentElement : null, "settings"), "settings");
			}, []);
			return h("div", { className: "dct-settings-row", "data-dct-ignore": "", ref },
				h("span", { className: "dct-settings-label" }, busy ? "جارٍ ترجمة الإعدادات…" : (props.layer.translated ? "استرجاع نصّ الإعدادات" : "ترجمة محتوى الإعدادات")),
				button(busy ? h(Spinner) : translateIcon(), () => {
					if (props.layer.translated) props.layer.restoreAll();
					else props.layer.setSurface("settings", true);
				}, {
					className: "dct-btn dct-icon",
					"data-on": props.layer.translated ? "1" : undefined,
					title: busy ? "جارٍ الترجمة…" : (props.layer.translated ? "استرجاع الأصل" : "ترجم محتوى الإعدادات"),
					"aria-label": busy ? "جارٍ الترجمة" : (props.layer.translated ? "استرجاع الأصل" : "ترجم محتوى الإعدادات")
				})
			);
		}

		/**
		 * The progress ring. The owner asked for it in plain words: with a slow model the
		 * button must show that work is happening, or "nothing happened" is indistinguishable
		 * from "the model is thinking". It reports real state (`layer.busy`), not a timer —
		 * a spinner that lies about progress is worse than none.
		 */
		function Spinner() {
			return h("span", { className: "dct-spin", "data-dct-ignore": "", role: "status", "aria-label": "جارٍ الترجمة" });
		}

		/** Re-render a control while the layer is working, so the ring appears with the work. */
		function useBusy(layer, subscribe) {
			const [, bump] = useState(0);
			useEffect(() => (subscribe ? subscribe(() => bump((n) => n + 1)) : undefined), []);
			return !!layer.busy;
		}

		/** The panel: state, counters, surface switches with a live probe, and the actions. */
		function Panel(props) {
			const layer = props.layer;
			const [, bump] = useState(0);
			const [hostLog, setHostLog] = useState(null);
			useEffect(() => { props.subscribe(() => bump((n) => n + 1)); }, []);
			/** Read the host's metadata log. Never the text: the host never stores it. */
			const readLog = () => {
				fetch(ROUTE + "/log?limit=6")
					.then((r) => r.json())
					.then((body) => setHostLog(body && body.ok ? body : { error: "سجلّ المضيف غير متاح" }))
					.catch(() => setHostLog({ error: "تعذّر قراءة سجلّ المضيف" }));
			};
			const c = layer.counters;
			const busy = useBusy(layer, props.subscribe);
			const probe = layer.scanRoots();
			const rows = Object.values(layer.state);
			const totalRoots = rows.reduce((a, s) => a + (s.roots || 0), 0);
			const queued = layer._internals ? layer._internals.queue.length : 0;
			return h("div", { className: "dct-panel", "data-dct-ignore": "", dir: "rtl", lang: "ar" },
				h("div", { className: "dct-title" }, "ترجمة المحتوى — Translate This"),
				h("div", { className: "dct-note" }, props.engine.label),
				h("div", { className: "dct-row" },
					h("span", null, "لغة الترجمة"),
					h("select", {
						className: "dct-select", value: layer.target, "data-dct-ignore": "",
						onChange: (e) => layer.setTarget(e.target.value)
					}, TARGETS.map((t) => h("option", { key: t.code, value: t.code }, t.label)))
				),
				busy ? h("div", { className: "dct-note dct-warn" },
					h("span", { className: "dct-spin", style: { marginInlineEnd: 6 } }),
					"جارٍ الترجمة… طلبات جارية " + layer.inflight + " · في الطابور " + queued) : null,
				layer.loopFlag ? h("div", { className: "dct-bad" }, "حلقة مشتبهة: أُوقفت الطبقة (أكثر من 300 حقن في ثانية).") : null,
				layer.debug ? h("div", { className: "dct-bad" }, layer.debug) : null,
				h("div", { className: "dct-sec" },
					h("div", { className: "dct-kv" }, h("span", null, "الأسطح المُعلَنة"), h("b", null, totalRoots === 0 ? "0 — لا سطح مطابق" : totalRoots + " مستهدف")),
					totalRoots === 0 ? h("div", { className: "dct-note dct-warn" },
						"لا سطح واحد مطابق الآن: هذا قياس، لا عطل صامت — أبلغ به كما هو.") : null,
					...rows.map((s) => h("div", { className: "dct-row", key: s.id },
						h("label", null, h("input", {
							type: "checkbox", checked: !!s.on, "data-dct-ignore": "",
							onChange: (e) => layer.setSurface(s.id, e.target.checked)
						}), " " + s.label),
						h("span", { style: { display: "inline-flex", gap: 6, alignItems: "center" } },
							h("b", null, (s.roots || 0) + " · " + tierLabel(s) + (s.markers ? " · رُكّبت " + s.markers : "") + (s.trust === "untrusted" ? " · غير موثوق" : "")),
							button("ترجم", () => layer.setSurface(s.id, true),
								{ className: "dct-btn dct-mini", title: "ترجم هذا السطح وحده" })
						)
					)),
					// Visible failures. An injected build once mounted, translated nothing and said
					// nothing — the registration had failed into a console.warn. Never again.
					...(layer.diagnostics.length ? layer.diagnostics.map((d, i) => h("div", { className: "dct-bad", key: "d" + i }, d)) : []),
					// One copyable line: the probe is the measurement, and a measurement that
					// cannot be quoted out of the GUI is a measurement nobody can check.
					h("div", { className: "dct-note", style: { marginTop: 6, userSelect: "all" } },
						"probe: " + rows.map((s) => s.id + "(" + s.tier + ")=" + (s.roots || 0) +
							(s.markers ? "/m" + s.markers : "")).join(" · ")),
					h("div", { className: "dct-note", style: { userSelect: "all" } },
						"dom: " + layer.discover().join(" · "))
				),
				h("div", { className: "dct-sec" },
					// The cost counter (§8 هـ5). Every number here is moved by a measured event: a
					// call the engine actually received, a segment that actually travelled, a
					// segment answered from the cache with zero calls. Tokens come from the
					// `usage` the model reported — and when it reported none, this says «غير
					// معروف» instead of showing a zero, because a counter that invents a number is
					// worse than no counter (measured: the stream's shape is not what the type
					// definitions promise until you look).
					h("div", { className: "dct-kv" }, h("span", null, "نداءات المحرّك (الدفعات)"), h("b", null, c.requests + (c.batchCalls ? " · دفعات " + c.batchCalls : ""))),
					h("div", { className: "dct-kv" }, h("span", null, "مقاطع أُرسلت"), h("b", null, c.segmentsRequested)),
					h("div", { className: "dct-kv" }, h("span", null, "مقاطع من الكاش (صفر كلفة)"), h("b", null, c.segmentHits)),
					h("div", { className: "dct-kv" }, h("span", null, "توكنات الدخل / الخرج"), h("b", null,
						c.usageCalls ? (c.tokensIn + " / " + c.tokensOut + " · كاش مقروء " + c.cacheReadTokens + " · مكتوب " + c.cacheWriteTokens + (c.usageUnknown ? " · " + c.usageUnknown + " بلا إبلاغ" : ""))
							: (c.usageUnknown ? "غير معروف (" + c.usageUnknown + " نداء بلا إبلاغ توكنات)" : "غير معروف"))),
					h("div", { className: "dct-kv" }, h("span", null, "فشل محاذاة (رُميت الدفعة كاملة)"), h("b", null, c.alignmentFailures)),
					h("div", { className: "dct-kv" }, h("span", null, "دفعات فاشلة"), h("b", null, c.failedBatches)),
					h("div", { className: "dct-kv" }, h("span", null, "مُخطَّى: حيّ/زائل منع ترجمته"), h("b", null, c.volatileSkipped)),
					h("div", { className: "dct-kv" }, h("span", null, "انتظار استقرار (تأجيل)"), h("b", null, c.settleDeferrals)),
					h("div", { className: "dct-kv" }, h("span", null, "كلفة آخر نداء"), h("b", null, c.lastCallMs ? c.lastCallMs + " ms" : "—")),
					h("div", { className: "dct-kv" }, h("span", null, "طلبات المحرّك (قديمًا: لكل كتلة)"), h("b", null, c.blocks)),
					h("div", { className: "dct-kv" }, h("span", null, "حقن"), h("b", null, c.injections)),
					h("div", { className: "dct-kv" }, h("span", null, "إعادة حقن من الكاش (بلا كلفة)"), h("b", null, c.reinjections)),
					h("div", { className: "dct-kv" }, h("span", null, "استسلام (حلقة)"), h("b", null, c.giveUps)),
					h("div", { className: "dct-kv" }, h("span", null, "نتائج متأخرة مُهمَلة"), h("b", null, c.droppedLate)),
					h("div", { className: "dct-kv" }, h("span", null, "وميض إنجليزي"), h("b", null, Math.round(c.flickerMs) + " ms")),
					h("div", { className: "dct-kv" }, h("span", null, "مخالفات شبكة"), h("b", null, c.network))
				),
				// The host's own call log, read on demand. Metadata only — segments, characters,
				// model, milliseconds, usage, outcome — which is exactly why it can be quoted in a
				// bug report without leaking a word of the user's content.
				h("div", { className: "dct-sec" },
					h("div", { className: "dct-row" },
						h("span", null, "سجلّ نداءات المضيف (ميتاداتا فقط)"),
						button("اقرأ", readLog, { className: "dct-btn dct-mini", title: "يقرأ عدّاد النداءات من المضيف" })
					),
					hostLog ? (hostLog.error
						? h("div", { className: "dct-bad" }, hostLog.error)
						: [
							h("div", { className: "dct-note" }, "إجمالي: " + hostLog.totals.calls + " نداء · " + hostLog.totals.segments + " مقطعًا · " +
								hostLog.totals.chars + " حرفًا · توكنات " + hostLog.totals.inputTokens + "/" + hostLog.totals.outputTokens +
								(hostLog.totals.callsWithoutUsage ? " · " + hostLog.totals.callsWithoutUsage + " بلا إبلاغ" : "") +
								" · فشل " + hostLog.totals.failed + " (منها محاذاة " + hostLog.totals.alignmentFailures + ")"),
							...hostLog.calls.map((row, i) => h("div", { className: "dct-note", key: "hlog" + i, style: { userSelect: "all" } },
								(i + 1) + ". " + row.mode + " · " + row.segments + " مقطعًا · " + row.chars + " حرفًا · " + row.ms + "ms · " +
								(row.ok ? "نجح" : String(row.code)) + (row.attempts > 1 ? " · " + row.attempts + " محاولات" : "") +
								(row.usage ? " · توكنات " + (row.usage.inputTokens ?? "?") + "/" + (row.usage.outputTokens ?? "?") : " · بلا توكنات") +
								(row.finish ? " · " + row.finish : "")))
						])
						: h("div", { className: "dct-note" }, "لم يُقرأ بعد — الزرّ يقرأ ميتاداتا (أحرف/موديل/مللي/توكنات)، ولا يقرأ نصًّا."),
					h("div", { className: "dct-note" },
						"الدفعات: حتى " + BATCH_SEGMENTS + " مقاطع أو " + BATCH_CHARS + " حرفًا في النداء الواحد، بفاصل مُرقَّم؛ وفشل المحاذاة يُرمي ولا يُخزَّن.")
				),
				h("div", { className: "dct-actions" },
					button(busy ? [h(Spinner), h("span", null, "جارٍ الترجمة…")]
						: (layer.translated ? [translateIcon(), h("span", null, "استرجاع الأصل")] : [translateIcon(), h("span", null, "ترجم هذا المحتوى")]),
						() => { if (layer.translated) layer.restoreAll(); else layer.translateRoots() },
						{ className: "dct-btn dct-wide" }),
					button("إلغاء", () => layer.cancel()),
					button("استرجاع الأصل", () => layer.restoreAll()),
					button("تفريغ الكاش", () => layer.clearCache()),
					props.onClose ? button("إغلاق", () => props.onClose()) : null
				),
				h("div", { className: "dct-note dct-sec" },
					"0.6: المحرّك نموذج DSH في المضيف (ctx.llm.stream) — بلا خدمة خارجية وبلا مفتاح ثانٍ. " +
					"الكاش بالمحتوى (كتلة + مقطع)، والأسطح غير الموثوقة بلا تخزين دائم، وسجلّ المضيف ميتاداتا فقط — لا نصّ خام.")
			);
		}

		/** Where a surface's roots came from — the label IS part of the measurement. */
		const TIER_LABEL = { slot: "فتحة", selector: "مُحدِّد", fallback: "احتياطي", none: "لا شيء" };
		const tierLabel = (s) => TIER_LABEL[s && s.tier] || TIER_LABEL.none;

		/**
		 * The header action: the owner asked for the icon instead of the sentence, so the
		 * face is the glyph and the sentence lives in `aria-label` + `title`. A control whose
		 * meaning only exists in a picture is a control nobody can read out loud.
		 */
		function HeaderAction(props) {
			const [open, setOpen] = useState(false);
			const busy = useBusy(props.layer, props.subscribe);
			const translated = props.layer.translated;      // useBusy subscribes, so this stays fresh
			// One button, two faces: press to translate, press again and the original text comes
			// back. The owner asked for exactly this, and it is the same restore the panel's
			// button performs — never a second implementation of "undo".
			const act = () => {
				if (props.layer.translated) props.layer.restoreAll();
				else props.layer.translateRoots();
				setOpen(true);
			};
			return h("span", { style: { display: "inline-flex", gap: 6, alignItems: "center" } },
				button(busy ? h(Spinner) : translateIcon(), act, {
					className: "dct-btn dct-icon",
					"data-on": translated ? "1" : undefined,
					title: busy ? "جارٍ الترجمة…" : (translated ? "استرجاع الأصل" : "ترجم هذا المحتوى"),
					"aria-label": busy ? "جارٍ الترجمة" : (translated ? "استرجاع الأصل" : "ترجم هذا المحتوى")
				}),
				open ? h(Panel, { layer: props.layer, engine: props.engine, subscribe: props.subscribe, onClose: () => setOpen(false) }) : null
			);
		}

		/* ==================================================================== *
		 * 5. wiring
		 * ==================================================================== */

		const inject = ["slots"];

		function apply(ctx) {
			let layer = null;
			/**
			 * One failing seat must not take the whole client half down — but it must not
			 * vanish either. A swallowed failure is exactly what made the first injection
			 * look healthy while it translated nothing (the slot registration had failed into
			 * a `console.warn`), so every failure now also lands in the panel.
			 */
			const safe = (label, fn) => {
				try { return fn(); }
				catch (error) {
					const message = String((error && error.message) || error);
					try { console.warn("[dsh-translate-this] " + label + " degraded: " + message); } catch { /* noop */ }
					if (layer) layer.note(label + " فشل: " + message);
					return undefined;
				}
			};

			const listeners = new Set();
			const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
			const engine = hostEngine(ENGINE_STATE)
			layer = createLayer({ engine, onChange: () => { for (const fn of listeners) { try { fn(); } catch { /* noop */ } } } });

			safe("style", () => {
				const style = document.createElement("style");
				style.textContent = STYLE;
				style.dataset.dctStyle = "";
				document.head.appendChild(style);
			});
			safe("first scan", () => layer.scanRoots());

			// Is the host engine actually there? Measured, never assumed — and if it is not, the
			// fallback is a visible line in the panel and a label that says "stub", not a silence
			// that looks like a working translator.
			safe("engine status", () => {
				// A host without the engine is a visible line and a label that says "stub" — never a
				// silence that looks like a working translator. Both entry points move together: a
				// fallback that replaced `translate` only would leave the batch path calling a host
				// that is not there.
				const useStub = (why) => {
					engine.translate = stubEngine.translate
					engine.translateBatch = stubEngine.translateBatch
					engine.label = stubEngine.label
					layer.note(why)
				}
				fetch(ROUTE + "/status").then((r) => r.json()).then((body) => {
					if (!body || body.engine !== "host") {
						useStub("المحرّك غير متاح في هذا المضيف (" + ((body && body.engine) || "لا استجابة") + ") — أترجم بمحرّك ثابت")
					} else {
						// The model and the prompt version ride in the cache key (§6.2): a key that
						// ignored them would serve one model's translation as another's.
						ENGINE_STATE.model = body.model || ""
						ENGINE_STATE.promptVersion = body.promptVersion || "batch-v1"
						ENGINE_STATE.ceilings = body.ceilings || null
						engine.label = "نموذج DSH — " + (body.model || "غير محدَّد")
					}
				}).catch(() => {
					useStub("تعذّر سؤال المضيف عن المحرّك — أترجم بمحرّك ثابت")
				})
			});

			// (The two keyed seats this plugin first tried — `conversation.chat.node` and
			// `tool.call.toolview` — are gone: the shell rejected them for lacking a key, and
			// the unhashed `data-conversation-*` markers do the job without a vocabulary we
			// would have had to guess. See SURFACES.)

			// A control in the place it acts on: the settings window gets the icon in its own
			// header (and a labelled row in General), and both translate the settings surface
			// only. The header icon in the conversation covers everything.
			//
			// Both seats are confirmed present in a live settings window — measured, not
			// guessed: opening it adds settings.header, settings.section, settings.general.item,
			// settings.action and settings.close to the shell's seat list.
			safe("slots:settings.action", () => {
				if (!ctx.slots || typeof ctx.slots.inject !== "function") return;
				ctx.slots.inject("settings.action", () => ctx.slots.register({
					name: "settings.action",
					id: "translate-this",
					order: 40
				}, () => h(SettingsIcon, { layer, subscribe })));
			});

			safe("slots:settings.general.item", () => {
				if (!ctx.slots || typeof ctx.slots.inject !== "function") return;
				ctx.slots.inject("settings.general.item", () => ctx.slots.register({
					name: "settings.general.item",
					id: "translate-this",
					order: 40
				}, () => h(SettingsRow, { layer, subscribe })));
			});

			// Native seats when the client runtime offers them (0.2+); a DOM-level dock
			// otherwise, so the button exists either way. Both are marked data-dct-ignore.
			let native = false;
			safe("slots:conversation.session.header.actions", () => {
				if (!ctx.slots || typeof ctx.slots.inject !== "function") return;
				ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
					name: "conversation.session.header.actions",
					id: "translate-this",
					order: 40
				}, (props) => h(HeaderAction, { layer, engine, subscribe })));
				native = true;
			});

			let dock = null;
			if (!native) {
				safe("dock", () => {
					dock = document.createElement("div");
					dock.setAttribute("data-dct-ignore", "");
					dock.style.cssText = "position:fixed;inset-block-start:12px;inset-inline-end:12px;z-index:999998";
					document.body.appendChild(dock);
					createRoot(dock).render(h(HeaderAction, { layer, engine, subscribe }));
				});
			}

			ctx.effect(() => () => {
				safe("dispose layer", () => layer.dispose());
				safe("dispose dock", () => { if (dock) { createRoot(dock).unmount?.(); dock.remove(); } });
			}, "dsh-translate-this: layer + ui");

			// A diagnostic handle: the layer is the product here, and a DOM injector that
			// cannot be inspected from the console is a DOM injector nobody can verify.
			safe("debug handle", () => { window.__dshTranslateThis__ = { layer, engine, version: "0.6.0" }; });
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
		/* The splitter and the gluer are the unit 0.6 caches on, and `acceptance/protocol.mjs`
		   drives them directly: a splitter that lost a byte would corrupt every translation
		   built on it, and that is cheaper to prove in node than to notice in a GUI. */
		exports.splitSegments = splitSegments;
		exports.composeSegments = composeSegments;
		return module.exports;
	}
});
