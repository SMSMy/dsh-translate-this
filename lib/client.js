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
		 *
		 * MEASURED, 2026-10-11, on a live GUI with five plugin panels open (three of them written
		 * by other people). What the measurements killed:
		 *
		 *   - `[class*="_toolCallPayload"]` → **0**. The rendered tool row is
		 *     `div[data-tool="<name>"][data-variant][data-state]` — the shell's own unhashed marker.
		 *   - `[class*="_documentPreview"]` → **0**. A preview body is `div[data-document-preview]`.
		 *   - `[role="dialog"]` for settings was wrong in the OTHER direction: it also matched the
		 *     «Preview Notice» modal (1 match on an empty hero page), so a notice could have been
		 *     translated as settings. The settings window carries its own `data-shortcut-modal`.
		 *   - **`[data-dockkit-pane]` / `[data-sidebar-right-panel]` match ZERO plugin panels.** The
		 *     measured answer: DSH 0.2 renders a plugin panel as a row in `sidebar.panellist` plus a
		 *     PAGE inside the main seat; the dock container the old table pointed at was measured
		 *     empty (`data-dockkit-empty`) while `panels.roots` confidently reported 2. A surface
		 *     that "works" and translates nothing meaningful is the failure mode this project keeps
		 *     paying for, which is why the table is gone (see the runtime registry below, and note
		 *     that no plugin is named on this page either).
		 *
		 * What stayed, because it was measured: `data-conversation-content/-scroll` (1 root, 3,909
		 * elements), `data-tool` (73 rows), `data-document-preview` (1 root, 1,084 elements), and
		 * the seat ledger marking every seat the shell renders.
		 */
		/**
		 * The limited attributes path (0.8) — and "limited" is a measurement, not a mood.
		 *
		 * MEASURED on a live third-party panel (2026-10-11): 93 `title` attributes carrying
		 * 4,625 characters, against 174 visible text nodes holding 3,364 — 58% more text than a
		 * text observer can see, because the rendered row is truncated and the full line lives
		 * in `title`. A surface declared translatable that ignores this stays half-translated,
		 * and the plan names this path («مسار السمات المحدود»).
		 *
		 * Bounded, on purpose:
		 *   - two names only (`title`, `aria-label`) — never `value`, `placeholder` or `dir`
		 *     (PLAN.md §5 rule 4: an authored `dir` is never touched);
		 *   - declared + enabled surfaces only, inside roots WE marked;
		 *   - never inside `[data-dct-ignore]`, never on code/controls/contenteditable;
		 *   - the value must look like prose (letters, a space, ≥ 8 chars) and not like data
		 *     (URL, Windows/UNC path, bare id) — a translated path is a broken path.
		 */
		const ATTR_NAMES = ["title", "aria-label"];
		const ATTR_MIN_CHARS = 8;
		const ATTR_MAX = 300;           // per root, per pass: a ceiling, so one pass stays bounded

		/* ==================================================================== *
		 * 1b. THE SURFACE REGISTRY — generated at runtime, never written by us
		 * ==================================================================== *
		 *
		 * Why this replaced a hand-written selector table (the owner's correction, verbatim):
		 * «المقصد ليس لوحةً بعينها … كل بلاقن يضيف لنا واجهة — لوحة جانبية، تبويبًا، مقعدًا في main،
		 * لوحةً في الشريط الأيمن، أو غطاءً في shell.overlay. وأنا أملك هذا البلاقن، وغيري يملك
		 * بلاقنات أخرى لم أرها ولن أراها؛ فما تبنيه يجب أن يعمل عليها كلها بلا سطر واحد خاص بأحدها.»
		 *
		 * A table of selectors can only cover the plugins that existed while it was written, and
		 * every "just add one more selector" is a promise to keep chasing plugins forever. So the
		 * registry is derived from two sources that belong to the SHELL, not to any plugin:
		 *
		 *   1. the seat ledger — `ctx.slots.snapshot()` — which names every live seat and, for
		 *      each occupant, the package that registered it (`registrant`). That is ownership
		 *      evidence, and it is how "third-party" is decided without naming anybody;
		 *   2. the unhashed markers the app puts on its own containers (`data-slot`,
		 *      `data-dockkit-*`, `data-sidebar-right-panel`, `data-dsh-part`, `data-shortcut-modal`
		 *      — all measured on a live GUI). No class name, so no build step can rename them.
		 *
		 * Identity is the SEAT/OWNER id (`main`, `sidebar.panellist`, `settings.*`, a dock tab,
		 * a conversation root, a tool row) — never a plugin name and never a panel type. One key
		 * per identity, however many elements carry it (a virtualized list has one seat and two
		 * hundred rows), and a key disappears when its seat does.
		 *
		 * The default for an UNKNOWN owner is ON, and that is deliberate: this plugin exists to
		 * translate plugin surfaces (PLAN.md D9: third-party panels are enabled by default), so a
		 * surface we cannot attribute must not be excluded by a rule written before it existed.
		 * A wrong ON costs one switch; a wrong OFF breaks the product for every plugin we have
		 * not met. Chrome is the case we can PROVE — the seat ledger says the shell owns it.
		 */
		/**
		 * `content: true` marks the few containers the plan declares as FIRST-CLASS content
		 * (replies, tool output, file previews): their trust is a product decision, not an
		 * ownership inference, because they are the surfaces the plugin is FOR (§1.3).
		 * Everything else is classified from the seat ledger, and an unknown owner is ON with no
		 * cache — the safe direction (see the note above).
		 */
		/**
		 * The markers the app puts on its own containers, each with the default measured for it.
		 *
		 * `trust: "untrusted"` ⇒ the surface keeps NOTHING (§6.7), and `on: false` ⇒ it is a frame,
		 * not a target: a container whose prose belongs to the identities inside it. The defaults
		 * are a product decision the plan already made — content surfaces are ON (§1.3), interface
		 * chrome is OFF (§1.2: translating the shell's own UI is the language packs' job, not ours)
		 * — and every one of them still gets its own switch in the panel.
		 */
		const HOST_MARKERS = [
			// identity attr, label, trust, on
			["data-conversation-content", "نصّ الردود", "stable", true],
			["data-conversation-scroll", "ممرّ الردود", "stable", true],
			["data-tool", "مخرجات الأدوات", "untrusted", true],
			["data-document-preview", "معاينات الملفات", "stable", true],
			["data-dockkit-content", "تبويب لوحة", "untrusted", true],
			["data-dockkit-pane", "لوحة مرصوفة", "untrusted", false],
			["data-sidebar-right-panel", "لوحة الشريط الأيمن", "untrusted", false],
			["data-dsh-part", "جزء من الشل", "untrusted", false],
			// The shell renders its own windows and this attribute is how it names them: provenance
			// by construction, so it is chrome and stays off (PLAN.md §3).
			["data-shortcut-modal", "نافذة الشل", "chrome", false],
		];

		/**
		 * The page seat. MEASURED on a live GUI with five panels open (three of them written by
		 * other people): a plugin panel is NOT a dock pane at all — DSH 0.2 renders it as a row in
		 * `sidebar.panellist` plus a PAGE inside the main seat, and the shell marks its own
		 * conversation page (`data-slot="main.conversation"`) while a panel's page carries no seat
		 * of its own. The measurement (`0/5` panels matched by the dock markers, `1` page per panel
		 * by this rule, `0` in the conversation) is what this rule is built on — and it names no
		 * plugin, because "the page the shell is showing that is not its own conversation" is a
		 * statement about the shell.
		 */
		const MAIN_PAGE_SELECTOR = '[data-slot="main"] > *:not([data-slot="main.conversation"])';
		/** Tags that never hold prose we want: a marker on one of these is not a surface. */
		const NON_PROSE_TAGS = new Set(["STYLE", "SCRIPT", "LINK", "META", "TEMPLATE", "NOSCRIPT", "HEAD"]);

		/** Is this registrant the harness itself (i.e. chrome we can prove)? */
		/**
		 * Fold the seat ledger into `name -> owner`. `snapshot()` is the shell's own view of every
		 * live slot, so this costs one call and names the owner of each seat without us knowing a
		 * single plugin. Absent service ⇒ an empty map ⇒ everything unknown ⇒ ON, which is the
		 * safe direction (see above).
		 */
		function seatOwners(slots) {
			const owners = new Map();
			if (!slots || typeof slots.snapshot !== "function") return owners;
			let tree;
			try { tree = slots.snapshot(); } catch { return owners }
			const walk = (node) => {
				if (!node || node.type !== "slot") return;
				let owner = null;
				for (const occ of node.occupants || []) if (occ && occ.registrant) owner = occ.registrant;   // last wins: the newest registration
				if (!owner && typeof node.declaredBy === "string") owner = node.declaredBy.replace(/\s*\(.*$/, "");
				owners.set(node.name, owner);
				for (const child of node.children || []) walk(child);
			};
			for (const node of tree || []) walk(node);
			return owners;
		}

		/**
		 * Build the registry from the live DOM + the seat ledger. Pure reading: it touches no DOM
		 * attribute and translates nothing, so it is safe to call on every sync.
		 */
		function buildRegistry(slots) {
			const owners = seatOwners(slots);
			const entries = new Map();
			const add = (identity, label, selector, on, trust, owner) => {
				const found = entries.get(identity);
				if (found) { found.roots += 1; return found }
				const entry = { id: identity, label, selector, on, trust, owner: owner || null, roots: 1, verified: true, kind: "registry" };
				entries.set(identity, entry);
				return entry;
			};
			// 1) the seats the shell itself renders. ONE query for all of them, grouped by value: a
			//    virtualized list repeats one seat many times, and a key per ELEMENT would drown the
			//    panel in rows that are all the same seat.
			//
			//    Default OFF, and that is a MEASURED decision, not caution: the seat ledger in this
			//    build reports its registrant as the client-instance id (`xf`) for every seat —
			//    measured on a live host — so ownership is NOT provable from it, and a default of
			//    "on" would translate the shell's whole interface. §1.2 locks the other way: the
			//    interface is the language packs' job. Every seat still gets its own key, the panel
			//    shows its owner string when the ledger has a usable one, and a control the shell
			//    places inside a panel turns its own seat on by being used (`translateElement`).
			let seatEls = [];
			try { seatEls = document.querySelectorAll("[data-slot]") } catch { seatEls = [] }
			for (const el of seatEls) {
				const name = el.getAttribute("data-slot");
				if (!name || NON_PROSE_TAGS.has(el.tagName)) continue;
				if (el.closest(IGNORE)) continue;
				const raw = owners.get(name);
				const owner = raw && /[\/]/.test(raw) ? raw : null;      // a package-shaped registrant, or nothing
				add("seat:" + name, name, '[data-slot="' + name.replace(/"/g, '\\"') + '"]',
					false, "untrusted", owner);
			}
			// 2) the app's own container markers: identity is the attribute itself (these carry no
			//    name of their own), and the default is declared per marker above.
			for (const [attr, label, trust, on] of HOST_MARKERS) {
				let els = [];
				try { els = document.querySelectorAll("[" + attr + "]") } catch { els = [] }
				for (const el of els) {
					if (NON_PROSE_TAGS.has(el.tagName)) continue;
					if (el.closest(IGNORE)) continue;
					add("part:" + attr, label, "[" + attr + "]", on, trust, null);
				}
			}
			// 3) the page seat: the page the shell is showing in `main`, when it is not the shell's
			//    own conversation page. This is where every plugin panel actually lives (measured:
			//    five panels from three vendors, 1/1 each, 0 in the conversation, and 0 of them
			//    matched by the dock markers the earlier table guessed at).
			let pages = [];
			try { pages = document.querySelectorAll(MAIN_PAGE_SELECTOR) } catch { pages = [] }
			for (const el of pages) {
				if (NON_PROSE_TAGS.has(el.tagName)) continue;
				if (el.closest(IGNORE)) continue;
				add("part:main.page", "صفحة اللوحة", MAIN_PAGE_SELECTOR, true, "untrusted", null);
			}
			return Array.from(entries.values());
		}

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
			target: (() => {
				try {
					const saved = localStorage.getItem("dct-target");
					return TARGETS.some((t) => t.code === saved) ? saved : "ar";
				} catch { return "ar"; }
			})()
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
				if (t === undefined || t === null || !piece.trim()) { out += piece; continue; }
				const lead = (piece.match(/^\s+/) || [""])[0];
				const trail = (piece.match(/\s+$/) || [""])[0];
				out += lead + String(t).replace(/^\s+/, "").replace(/\s+$/, "") + trail;
			}
			return out;
		}

		/* ==================================================================== *
		 * 2c. atomic tokens — masked before segmentation (PLAN.md §6.1)
		 * ==================================================================== */

		/**
		 * Code, URLs, commands, paths, versions, hashes, `ctx.`-identifiers and `{placeholders}`
		 * are replaced by `<<<K1>>>` markers BEFORE the text is split, and restored after it comes
		 * back. Three things follow, and all three are the point:
		 *
		 *   1. **The splitter can never cut inside them** — a sentence terminator in
		 *      `README.md` or `npx @deepseek-ai/dsh` stops being a boundary risk by construction.
		 *   2. **They do not enter the cache key** (§6.1, verbatim: «ولا تدخل التجزئة») — the same
		 *      sentence with a different URL is the SAME segment, so its translation is reused.
		 *   3. **Survival is checked, not hoped for** — a translation that lost a marker is
		 *      refused by `unmaskTokens` and never injected, never cached. «100% سلامة للكود»
		 *      (PLAN.md هـ3) is a gate here, not a wish.
		 *
		 * The marker is the same family as the batch separator `<<<DCT:n>>>`, which a real model
		 * returned character-for-character, and distinct enough not to be confused with it. The
		 * survival rate is measured by `acceptance/golden.mjs` rather than assumed here.
		 */
		const TOKEN_PATTERNS = [
			/`[^`\n]+`/g,                                                            // `code span`
			/https?:\/\/[^\s<>()"]+/g,                                               // URLs
			/@[a-z0-9-]+\/[a-z0-9._-]+/gi,                                           // @scope/package
			/[\w.-]+\/[\w./-]*[\w-]\.(?:js|mjs|cjs|json|ya?ml|md|ts|tsx|css|html|py|sh|ps1|exe|png|svg)\b/gi,
			/\b[\w.-]+\.(?:js|mjs|cjs|json|ya?ml|md|ts|tsx|css|html|py|sh|ps1)\b/gi,  // bare file names
			/\{[a-zA-Z_][\w.]*\}/g,                                                  // {placeholder}
			/\bctx(?:\.[A-Za-z_$][\w$]*)+\b/g,                                       // ctx.llm.stream
			/(?<![\w-])--?[a-z][a-z0-9-]{1,}/g,                                      // --flag
			/\bv?\d+\.\d+(?:\.\d+)*\b/g,                                             // v1.2.3
			/\b[0-9a-f]{7,40}\b/gi,                                                  // fingerprint
			/\b(?:npx|npm|pnpm|node|git|gh|adb|chrome)\b/g                           // commands
		];

		/**
		 * Mask the atomic tokens of one text.
		 * @returns `{ text, tokens }` where `tokens[i]` is the value behind `<<<K(i+1)>>>`.
		 */
		function maskTokens(text) {
			let out = String(text ?? "");
			const tokens = [];
			const index = new Map();
			const placeholderFor = (value) => {
				let at = index.get(value);
				if (at === undefined) { at = tokens.length + 1; tokens.push(value); index.set(value, at); }
				return "<<<K" + at + ">>>";
			};
			for (const pattern of TOKEN_PATTERNS) {
				out = out.replace(pattern, (match) => placeholderFor(match));
			}
			return { text: out, tokens };
		}

		/**
		 * Put the values back, and refuse a translation that lost one.
		 *
		 * `missing` and `leaked` are both failures: a marker that vanished means the model dropped
		 * a path or a command, and a mangled marker that survived (say `<<< K1 >>>`) would put
		 * that garbage on the screen. Either way the translation is not used.
		 */
		function unmaskTokens(text, tokens) {
			let out = String(text ?? "");
			const missing = [];
			let stripped = out;
			for (let i = 0; i < tokens.length; i += 1) {
				const marker = "<<<K" + (i + 1) + ">>>";
				stripped = stripped.split(marker).join("");
			}
			const leaked = /<<<K|<<<DCT|<<<\s*K/i.test(stripped);
			for (let i = 0; i < tokens.length; i += 1) {
				const marker = "<<<K" + (i + 1) + ">>>";
				if (!out.includes(marker)) { missing.push(i + 1); continue; }
				out = out.split(marker).join(tokens[i]);
			}
			return { text: out, missing, leaked };
		}

		/**
		 * Build the injector layer over a given engine and surface table.
		 * @param options.engine - `{ translate(text) -> Promise<string> }` (0.5: a stub).
		 * @param options.surfaces - an EXPLICIT surface table. The acceptance page passes its own
		 *   because its fixtures are not DSH's DOM — the layer is what is under test there. The
		 *   plugin passes NOTHING: with no table, the surfaces come from the runtime registry
		 *   (`ctx.slots` + the app's own markers), which is the only thing that can cover plugins
		 *   nobody has written yet.
		 * @param options.slots - the shell's seat ledger (`ctx.slots`), the registry's source of
		 *   identity and ownership.
		 * @param options.onChange - called when counters/state move, so the UI can redraw.
		 */
		function createLayer(options) {
			const engine = options.engine;
			const explicitTable = options.surfaces || null;
			const registryMode = !explicitTable;
			const notify = () => { try { options.onChange?.(); } catch { /* the UI must never break the layer */ } };

			const L = {
				state: explicitTable
					? Object.fromEntries(explicitTable.map((s) => [s.id, { ...s, roots: 0, attrTargets: 0 }]))
					: {},
				slots: options.slots || null,   // the shell's own seat ledger: identity + ownership
				keys: new Map(),                // id -> the user's own on/off, which outlives a re-sync
				registryAt: 0,                  // when the registry was last re-derived (throttle)
				cache: new Map(),          // BLOCK key -> composed translation (PLAN.md §6.2)
				segments: new Map(),       // SEGMENT key -> translation: the unit 0.6 caches on
				segPending: new Map(),     // segment key -> { key, text, waiters }: the batch queue
				segTimer: null,            // one dispatch per tick, never one per segment
				records: new Map(),        // text node -> { source, translation, key, gen, host, surface }
				hosts: new Map(),          // parent element -> { source, key, surface }: survives a node swap
				queue: [],
				held: new Map(),           // key -> { count, until }: the give-up rule
				gen: 0,
				pending: false,            // a frame is already scheduled to DRAIN the queues (pump)
				scanPending: false,        // a frame is already scheduled to RE-SCAN the roots (observer)
				loopFlag: false,
				enabled: true,
				rate: [],
				target: ENGINE_STATE.target,   // the language the cache key is built on
				inflight: 0,                // engine CALLS in flight (a batch is one call), for the spinner
				blocksWaiting: 0,           // blocks waiting on segments: separates "queued" from "called"
				diagnostics: [],            // visible failures: a surface that found nothing says so
				debug: null,               // last failure, shown in the panel rather than swallowed
				rekeyModel(newModel) {
					if (!newModel || typeof newModel !== "string") return;
					const oldPart = "\u0001?\u0001";
					const newPart = "\u0001" + newModel + "\u0001";
					for (const [k, v] of Array.from(L.cache.entries())) {
						if (k.includes(oldPart)) {
							L.cache.delete(k);
							L.cache.set(k.replace(oldPart, newPart), v);
						}
					}
					for (const [k, v] of Array.from(L.segments.entries())) {
						if (k.includes(oldPart)) {
							L.segments.delete(k);
							L.segments.set(k.replace(oldPart, newPart), v);
						}
					}
				},
				lastWrite: new Map(),       // node -> when the app last wrote it: the settle window
				// 0.8 — the limited attributes path. Same rules as text, three separate stores so
				// a half-attribute state can never masquerade as a text record (and vice versa).
				attrs: new Map(),           // element -> { name, source, translation, key, surface, gen }
				attrSeen: new Map(),        // element -> first time we looked at it (the settle clock's floor)
				attrDefer: new Map(),       // element -> Map(name -> deferral count)
				attrQueue: [],              // [{ el, name }] waiting for the next frame
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
				            cacheReadTokens: 0, cacheWriteTokens: 0, lastCallMs: 0, lastUsage: null,
				            // §6.1/هـ3: how many atomic tokens we protected, and how many replies were
				            // REFUSED because a token did not survive. Both are measurements, not claims.
				            tokensProtected: 0, integrityFailures: 0,
				            // 0.8: the attributes path counts itself separately. An injected `title`
				            // is not an injected text node, and a counter that merged them would make
				            // "how much of the panel is Arabic?" unanswerable.
				            attrInjections: 0, attrRestores: 0, attrDropped: 0, attrAttempts: 0 }
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

			/**
			 * The cache key of a RAW text: masking first, because §6.1 keeps atomic tokens out of
			 * the key. Used by every path that meets a node before it has a token table — the
			 * anti-flicker lookup in `flush` and the default inside `inject`.
			 */
			const keyOfRaw = (text) => keyOf(maskTokens(text).text);

			/**
			 * Is this node's translation actually ON SCREEN right now?
			 *
			 * The button's state must answer "is what I am looking at already translated", and a
			 * node inside a hidden settings tab is not. That is exactly the owner's report: he
			 * translated one settings tab, moved to another, and the button stayed pressed —
			 * because the state was global (`records.size > 0`) instead of per surface and
			 * per what is visible.
			 */
			function isVisible(node) {
				const el = node.nodeType === 1 ? node : node.parentElement;
				if (!el || !el.isConnected) return false;
				if (typeof el.checkVisibility === "function") return el.checkVisibility({ visibilityProperty: true, opacityProperty: false, contentVisibilityAuto: false });
				return el.offsetParent !== null;
			}

			/** How many translations are on screen for one surface (or for all of them). */
			function countTranslated(surfaceId) {
				let n = 0;
				for (const [node, rec] of L.records) {
					if (surfaceId && rec.surface !== surfaceId) continue;
					if (!isVisible(node)) continue;
					n += 1;
				}
				// A translated `title` counts as translated too: the button must answer "is what
				// I am looking at already Arabic", and a panel whose rows are Arabic but whose
				// tooltips are not is not that. Visibility is the element's own.
				for (const [el, rec] of L.attrs) {
					if (surfaceId && rec.surface !== surfaceId) continue;
					if (!isVisible(el)) continue;
					n += 1;
				}
				return n;
			}

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
				// The generation rides along: a RESTORE between the deferral and its timer kills the
				// stale work instead of re-translating text the user just asked back. Measured on a
				// live panel: `restoreElement` left 41% of the panel Arabic because a deferred pass
				// landed after the undo.
				const gen = L.gen;
				setTimeout(() => { if (L.enabled && gen === L.gen) schedule(node); }, Math.max(16, Math.min(SETTLE_MS, Math.ceil(waitMs))));
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

			/* ---- the limited attributes path (0.8) ----
			 * Attributes are a different animal from text nodes, and the differences are the
			 * whole design here:
			 *   - the observer never sees them (`childList` + `characterData` only), so there is
			 *     no write record to time a settle window with. The honest substitute is the
			 *     element's own SUBTREE: any childList/characterData record inside it reaches us,
			 *     and the newest such write is "the app is still working here" (measured on the
			 *     live log-style panel, where every row is rewritten as its stream advances).
			 *   - they are never written through `muted()` (rule 11 / ح-15): attribute writes
			 *     produce no records, and `takeRecords()` would discard the app's pending ones.
			 *   - they are translated ON DEMAND, never by the observer. A live stream rewrites
			 *     rows faster than any translator can answer, and paying tokens for rows that
			 *     scroll away is exactly the cost failure هـ5 is written against.
			 */
			function attrSurface(el) {
				const host = el && el.closest && el.closest("[" + SURFACE_ATTR + "]");
				return host ? host.getAttribute(SURFACE_ATTR) || "" : null;
			}

			/** The newest write anywhere in this element's subtree — the attribute settle clock. */
			function lastWriteIn(el) {
				let t = L.attrSeen.get(el) || 0;
				const nodes = [];
				textNodesIn(el, nodes, 40);
				for (const n of nodes) { const w = L.lastWrite.get(n); if (w && w > t) t = w; }
				return t;
			}

			/**
			 * Is this attribute value prose we are willing to translate? Returns the normalized
			 * value or null. The "not data" half is not decoration: a translated file path or
			 * URL is a broken path, and the shell puts both in `title` (measured: the tool rows
			 * carry the file path in `title`, the log rows carry a timestamp + pid + tag).
			 */
			function attrProse(value) {
				const v = norm(value);
				if (v.length < ATTR_MIN_CHARS) return null;
				if (!/\p{L}/u.test(v)) return null;                 // no letters at all: an id, a count, a glyph
				if (!/\s/.test(v)) return null;                     // one token: a slug, a filename, a name
				if (/(:\/\/|\b[A-Za-z]:\\|^\\\\|[\w.+-]+@[\w-]+\.[\w.]+)/.test(v)) return null;  // URL / path / mail
				if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(v)) return null;                 // a bare uuid
				return v;
			}

			function deferAttr(el, name, waitMs) {
				let per = L.attrDefer.get(el);
				if (!per) { per = new Map(); L.attrDefer.set(el, per); }
				const n = (per.get(name) || 0) + 1;
				per.set(name, n);
				if (n > MAX_DEFERRALS) { L.counters.volatileSkipped += 1; notify(); return; }
				L.counters.settleDeferrals += 1;
				const gen = L.gen;      // a restore between deferral and timer kills the stale pass (see deferRequest)
				setTimeout(() => { if (L.enabled && gen === L.gen) scheduleAttr(el, name); }, Math.max(16, Math.min(SETTLE_MS, Math.ceil(waitMs))));
			}

			function scheduleAttr(el, name) {
				if (!L.attrSeen.has(el)) L.attrSeen.set(el, now());
				if (L.attrQueue.length < 500 && !L.attrQueue.some((x) => x.el === el && x.name === name)) L.attrQueue.push({ el, name });
				pump();
			}

			/** Queue every attribute target of one marked root; returns how many were queued. */
			function scheduleAttrsIn(root, surfaceId) {
				let n = 0;
				const selector = ATTR_NAMES.map((a) => "[" + a + "]").join(",");
				let all = [];
				try { all = root.querySelectorAll(selector) } catch { return 0 }
				for (const el of all) {
					if (n >= ATTR_MAX) break;
					if (el.closest(IGNORE)) continue;
					for (const name of ATTR_NAMES) {
						const value = el.getAttribute(name);
						if (value === null || !attrProse(value)) continue;
						if (attrSurface(el) !== surfaceId) continue;      // a nested surface owns it; its own key decides
						const rec = L.attrs.get(el);
						if (rec && rec.name === name && el.getAttribute(name) === rec.translation) continue;
						if (!L.attrSeen.has(el)) L.attrSeen.set(el, now());   // the settle clock starts at first sight
						scheduleAttr(el, name);
						n += 1;
					}
				}
				return n;
			}

			/**
			 * Write a translated attribute. No `muted()` — rule 11: these writes are not observed,
			 * and wrapping them would run `takeRecords()` and swallow the app's queued records.
			 */
			function injectAttr(el, name, translation, surfaceId, key) {
				const source = norm(el.getAttribute(name) || "");
				el.setAttribute(name, translation);
				L.attrs.set(el, { name, source, translation, key, surface: surfaceId ?? attrSurface(el), gen: L.gen });
				L.debug = null;
				L.counters.attrInjections += 1;
				guardRate();
				notify();
			}

			/** Hand an attribute back its original value, literally — or drop the record if the app moved on. */
			function restoreAttrs(surfaceId, root) {
				let n = 0;
				for (const [el, rec] of Array.from(L.attrs)) {
					if (surfaceId && rec.surface !== surfaceId) continue;
					if (root && !root.contains(el)) continue;         // the seat control's undo scopes to one element
					if (el.isConnected && el.getAttribute(rec.name) === rec.translation) { el.setAttribute(rec.name, rec.source); n += 1; }
					L.attrs.delete(el);
					L.attrDefer.delete(el);
				}
				L.counters.attrRestores += n;
				return n;
			}

			/**
			 * The attribute repair sweep: a translated `title` the app overwrote with the ORIGINAL
			 * comes back from the cache (zero calls), bounded by the same give-up rule as text, and
			 * a record whose element moved to different text is dropped (recycled).
			 */
			function sweepAttrs() {
				for (const [el, rec] of Array.from(L.attrs)) {
					if (!el.isConnected) { L.attrs.delete(el); continue; }
					const current = el.getAttribute(rec.name);
					if (current === rec.translation) continue;                  // ours, still on screen
					if (current !== rec.source) {                                // recycled for other text
						L.attrs.delete(el);
						L.counters.attrDropped += 1;
						continue;
					}
					const cached = L.cache.get(rec.key);
					if (cached === undefined) { L.attrs.delete(el); continue; }
					const restored = unmaskTokens(cached, maskTokens(rec.source).tokens);
					if (restored.missing.length || restored.leaked) { L.attrs.delete(el); continue; }
					const hold = L.held.get(rec.key) || { count: 0, until: 0 };
					hold.count += 1;
					if (hold.count > 2) { hold.until = now() + GIVE_UP_MS; L.held.set(rec.key, hold); L.counters.giveUps += 1; continue; }
					L.held.set(rec.key, hold);
					L.counters.reinjections += 1;
					injectAttr(el, rec.name, restored.text, rec.surface, rec.key);   // FROM CACHE: no engine call
				}
			}

			/** Drain the attribute queue. Re-checks everything: the DOM moved between frames. */
			function flushAttrs() {
				const batch = L.attrQueue.splice(0, L.attrQueue.length);
				for (const item of batch) {
					const el = item.el;
					if (!el.isConnected) continue;
					const id = attrSurface(el);
					if (id === null) continue;
					const surface = L.state[id];
					if (!surface || !surface.on) continue;
					if (el.closest(IGNORE)) continue;
					const value = el.getAttribute(item.name);
					if (value === null || !attrProse(value)) continue;
					const rec = L.attrs.get(el);
					if (rec && rec.name === item.name && value === rec.translation) continue;   // already ours
					requestAttr(el, item.name);
				}
				sweepAttrs();
				notify();
			}

			/* ---- the injector ---- */
			/**
			 * @param key - the cache key this translation lives under. Passed in by the caller
			 *   because the key is built on the MASKED text (§6.1) while the node holds the raw
			 *   one; recomputing it here from `nodeValue` would key the repair path differently
			 *   from the write path, and the anti-flicker rule would silently stop working.
			 */
			function inject(node, translation, surfaceId, key) {
				const source = norm(node.nodeValue || "");
				const cacheKey = key || keyOfRaw(source);
				const host = directionHost(node);
				muted(() => {
					node.nodeValue = translation;                        // value only: no structure change
					if (host) {
						const dir = (L.target === "ar" ? "rtl" : "ltr");
						host.setAttribute(MARK, "1");
						host.setAttribute("dir", dir);
						host.style.unicodeBidi = "isolate";
					}
				});
				L.records.set(node, { source, translation, key: cacheKey, gen: L.gen, host: host || null, surface: surfaceId ?? surfaceOf(node) });
				// A translation reached the screen, so the last failure is no longer current. The
				// owner's report: «الترجمة تعمل بنجاح» while a red «فشل المحرّك: EMPTY_REPLY» line
				// stayed in the panel forever — a stale error is a false statement, not a history.
				L.debug = null;
				// Remember the BLOCK, not just the node: React replaces text nodes as readily as
				// it rewrites them, and a block the user translated must not silently fall back
				// to English because the node it used to hold is gone.
				// The block memory carries the translation itself, not just the key: an untrusted
				// surface keeps no cache (§6.7), and WITHOUT this the anti-flicker repair would have
				// nothing to put back — the app overwriting our Arabic with the original would win.
				// This is per-node state about a translation we already showed, not a cache.
				const parent = node.parentElement;
				if (parent) L.hosts.set(parent, { source, key: cacheKey, surface: surfaceId ?? surfaceOf(node), translation, owner: node });
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
				// No cache entry (an untrusted surface keeps none): repair from the BLOCK MEMORY,
				// which remembers the translation we already displayed. Zero engine calls either way.
				if (cached === undefined) {
					if (mem.translation === undefined) return false;
					const hold = L.held.get(mem.key) || { count: 0, until: 0 };
					hold.count += 1;
					if (hold.count > 2) { hold.until = now() + GIVE_UP_MS; L.held.set(mem.key, hold); L.counters.giveUps += 1; return false; }
					L.held.set(mem.key, hold);
					L.counters.reinjections += 1;
					if (!L.counters.englishSince.has(node)) L.counters.englishSince.set(node, now());
					inject(node, mem.translation, mem.surface);
					return true;
				}
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

			/**
			 * In-flight engine calls, so a cancel can tell the HOST to stop paying (0.8 hardening).
			 *
			 * Before this, `cancel()` raised the generation and dropped the answer when it finally
			 * arrived — by which time the tokens were already spent. An independent harness measured
			 * the plumbing as absent: the engine received no `signal` at all (`signal=مفقود`), and
			 * the browser check that now guards this saw `aborted=false` while a call sat in flight.
			 */
			const inflightAborts = new Set();
			const abortInflight = () => {
				const live = Array.from(inflightAborts);
				inflightAborts.clear();
				for (const c of live) { try { c.abort() } catch { /* the call already settled */ } }
			};

			/* ---- batching: N segments in one call, one dispatch per tick ---- */

			/**
			 * Ask for one segment. Identical segments coalesce here — the same sentence in two
			 * replies is one request — and the dispatch is deferred to a timer, so a click that
			 * schedules forty blocks produces batches instead of forty calls.
			 */
			function ensureSegment(item) {
				return new Promise((resolve, reject) => {
					if (!item.noCache && L.segments.has(item.key)) return resolve(true);
					let entry = L.segPending.get(item.key);
					if (!entry) { entry = { key: item.key, text: item.text, waiters: [], noCache: !!item.noCache }; L.segPending.set(item.key, entry); }
					// If ANY requester may not keep this segment, nobody keeps it: a shared segment
					// stored because one surface was trusted would put untrusted text in the cache.
					entry.noCache = entry.noCache || !!item.noCache;
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
				// The handle the cancel path aborts: passing a signal down is what turns "stop
				// showing me this" into "stop charging me for this".
				const controller = typeof AbortController === "function" ? new AbortController() : null;
				if (controller) inflightAborts.add(controller);
				const signal = controller ? controller.signal : undefined;
				try {
					if (typeof engine.translateBatch !== "function") {
						const e = new Error("المحرّك لا يعرف الدفعات (translateBatch مفقود)");
						e.code = "NO_BATCH";
						throw e;
					}
					const payload = await engine.translateBatch(texts, { target: L.target, signal });
					if (payload && payload.model && payload.model !== ENGINE_STATE.model) {
						ENGINE_STATE.model = payload.model;
						L.rekeyModel(payload.model);
					}
					const list = payload && Array.isArray(payload.segments) ? payload.segments : null;
					if (!list || list.length !== texts.length) {
						const e = new Error("محاذاة الدفعة فشلت: أُعيد " + (list ? list.length : "لا شيء") + " من " + texts.length);
						e.code = "ALIGNMENT_FAILED";
						throw e;
					}
					// A batch may mix trusted and untrusted requesters; the untrusted ones veto the
					// store (see `ensureSegment`), so a segment that ever came from a third-party
					// surface never lands in the cache.
					for (let i = 0; i < entries.length; i += 1) if (!entries[i].noCache) L.segments.set(entries[i].key, String(list[i]));
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
					// Each waiter gets ITS OWN segment back (not a bare `true`): an untrusted surface
					// cannot read it from anywhere afterwards, by design.
					entries.forEach((entry, i) => {
						const waiters = entry.waiters;
						entry.waiters = [];
						for (const w of waiters) w.resolve(String(list[i]));
					});
				} catch (error) {
					const code = String((error && error.code) || (error && error.name) || "TRANSPORT");
					// A cancel is not a failure. The user asked for it, the generation already
					// says the result is dead, and a red line reading «فشل المحرّك» after the
					// user's own cancel is exactly the lie this project refuses to ship.
					const cancelled = !!(signal && signal.aborted);
					if (!cancelled) {
						L.counters.failedBatches += 1;
						if (code === "ALIGNMENT_FAILED") L.counters.alignmentFailures += 1;
						L.debug = "فشل المحرّك (" + code + "): " + String((error && error.message) || error);
					}
					for (const entry of entries) {
						const waiters = entry.waiters;
						entry.waiters = [];
						for (const w of waiters) w.reject(error);
					}
				} finally {
					if (controller) inflightAborts.delete(controller);
					L.inflight -= 1;
					notify();
				}
			}

			/**
			 * THE pipeline: one implementation for both kinds of target — a text node and a
			 * bounded attribute. It was extracted in 0.8 for the reason this project keeps
			 * re-learning: a second copy of "cache, segments, batch, compose, integrity, write"
			 * would drift from the first, and the drift would be invisible in whichever copy the
			 * acceptance page happened not to drive.
			 *
			 * @param raw - the source text (normalized by the caller)
			 * @param surfaceId - the surface this translation is attributed to
			 * @param guard - still valid to write? (generation, connectivity, and "the value is
			 *   STILL exactly what we translated" — the recycled-node rule, §6.8)
			 * @param write - (translation, key) => void: the injector for this target kind
			 */
			async function translateThrough(raw, surfaceId, guard, write) {
				// §6.1: atomic tokens are masked BEFORE segmentation, so they neither break a cut
				// nor enter a cache key. Everything below works on the masked text; the target keeps
				// the raw one, and the values come back at the very end — or the block is refused.
				const masked = maskTokens(raw);
				const source = masked.text;
				const key = keyOf(source);
				const gen = L.gen;
				// §6.6/§6.7, and now a measured rule rather than an intention: an UNTRUSTED surface
				// keeps NOTHING — not a block, not a segment. The acceptance criterion for third-party
				// surfaces is «صفر إدخالات كاش، يُقاس من الطبقة نفسها», so the caches are bypassed on
				// both ends instead of being filled and explained away. The anti-flicker repair does
				// not depend on them: it reads the block memory (source + translation), which is
				// per-node state, not a cache.
				const trust = L.state[surfaceId] ? L.state[surfaceId].trust : null;
				const useCache = trust !== "untrusted";
				const cached = useCache ? L.cache.get(key) : undefined;
				if (cached !== undefined) {
					const restored = unmaskTokens(cached, masked.tokens);
					if (!restored.missing.length && !restored.leaked) { write(restored.text, key); return true; }
					L.cache.delete(key);                                     // a cached value that cannot be unmasked is not a value
				}
				const hold = L.held.get(key);
				if (hold && now() < hold.until) return false;            // we stopped fighting this key

				const pieces = splitSegments(source);
				const items = pieces.map((piece) => {
					const text = piece.trim();
					return { piece, text, key: text === "" ? null : keyOf(text), noCache: !useCache };
				});
				const missing = [];
				for (const item of items) {
					if (item.key === null) continue;                     // pure spacing: copied, never sent
					if (useCache && L.segments.has(item.key)) { L.counters.segmentHits += 1; continue; }
					missing.push(item);
				}
				L.counters.blocks += 1;
				L.blocksWaiting += 1;
				notify();
				try {
					// Where an untrusted surface reads its answer from: the batch hands each segment
					// back to its waiter, so a surface that may keep NOTHING still gets its text.
					// This map lives for the length of one call and is never stored anywhere.
					const delivered = new Map();
					if (missing.length) {
						// allSettled, not all: one rejected batch must not leave the other promises
						// unhandled, and every one of them carries the same "nothing was stored" meaning.
						const settled = await Promise.allSettled(missing.map((item) => ensureSegment(item)));
						const bad = settled.find((r) => r.status === "rejected");
						if (bad) throw bad.reason;
						missing.forEach((item, i) => {
							const r = settled[i];
							if (r && r.status === "fulfilled" && typeof r.value === "string") delivered.set(item.key, r.value);
						});
					}
					if (gen !== L.gen) { L.counters.droppedLate += 1; notify(); return false; }
					// The target moved on: a recycled node, a re-rendered attribute, a per-node restore.
					if (!guard()) { L.counters.droppedLate += 1; notify(); return false; }
					const translations = items.map((item) => (item.key === null ? null : (useCache ? L.segments.get(item.key) : delivered.get(item.key))));
					if (translations.some((t, i) => t === undefined && items[i].key !== null)) {
						const e = new Error("مقطع مفقود عند التركيب — لا حقن جزئي");
						e.code = "PARTIAL";
						throw e;
					}
					const composed = composeSegments(pieces, translations);
					// The integrity gate (PLAN.md هـ3: 100% سلامة للكود والمعرّفات). A reply that
					// lost a path, a command or a placeholder is refused here: it is not shown, and
					// — because it is never stored — it cannot be shown later from a cache either.
					const restored = unmaskTokens(composed, masked.tokens);
					if (restored.missing.length || restored.leaked) {
						L.counters.integrityFailures += 1;
						const e = new Error("فقدان رمز محميّ (" + (restored.missing.length ? "مفقود " + restored.missing.join(",") : "علامة مشوّهة") + ") — لم تُحقن ولم تُخزَّن");
						e.code = "INTEGRITY";
						throw e;
					}
					if (masked.tokens.length) L.counters.tokensProtected += masked.tokens.length;
					// §6.7 enforced rather than intended: a third-party surface stores nothing at all.
					if (useCache) L.cache.set(key, composed);            // masked: reusable with other values
					write(restored.text, key);
					return true;
				} catch (error) {
					// A superseded request is not a failure to report: `cancel()` and `restoreAll()`
					// bump the generation, so an answer that arrives now was already dead when it
					// arrived — and a red line reading «فشل المحرّك» after the user's own cancel is
					// a lie about the product (the abort above is the user's act, not a defect).
					if (gen === L.gen) L.debug = "فشل المحرّك: " + String((error && error.message) || error);
					// A segment refused by the integrity gate must not stay in the segment cache:
					// it would be reused verbatim by the next block that shares the sentence, and
					// the failure would repeat forever instead of being re-requested.
					if (String(error && error.code) === "INTEGRITY") {
						for (const item of items) if (item.key) L.segments.delete(item.key);
					}
					return false;
				} finally {
					L.blocksWaiting -= 1;
					notify();
				}
			}

			/**
			 * Translate one text block: the settle window and the live/ephemeral rule first, then
			 * the shared pipeline. Injection waits for the WHOLE block — half a block in Arabic
			 * and half in English is not a state this project ships — but every segment is stored
			 * on its own, so the next block sharing a sentence pays zero.
			 */
			async function request(node, surfaceId) {
				const raw = norm(node.nodeValue || "");
				// §5 rule 2 / §6.4: never translate a block that is still being written.
				const quiet = now() - (L.lastWrite.get(node) ?? 0);
				if (quiet < SETTLE_MS) { deferRequest(node, SETTLE_MS - quiet); return; }
				if (isVolatile(node, maskTokens(raw).text)) { noteVolatile(node); return; }
				await translateThrough(raw, surfaceId, () => node.isConnected && norm(node.nodeValue || "") === raw,
					(text, key) => inject(node, text, surfaceId, key));
			}

			/**
			 * Translate one attribute value (0.8). Same pipeline, different settle clock: the
			 * observer cannot see attribute writes, so the clock is the element's own subtree —
			 * and the readout rule still applies to the value itself (`title="12,345 tokens · 3.2 s"`
			 * is a counter, not prose).
			 */
			async function requestAttr(el, name) {
				L.counters.attrAttempts += 1;      // "the path was entered" is a measurement too
				const current = el.getAttribute(name);
				if (current === null) return;
				const raw = norm(current);
				if (raw === "" || !attrProse(raw)) return;
				const quiet = now() - lastWriteIn(el);
				if (quiet < SETTLE_MS) { deferAttr(el, name, SETTLE_MS - quiet); return; }
				if (looksLikeReadout(raw)) { L.counters.volatileSkipped += 1; notify(); return; }
				await translateThrough(raw, attrSurface(el),
					() => el.isConnected && norm(el.getAttribute(name) || "") === raw,
					(text, key) => injectAttr(el, name, text, attrSurface(el), key));
			}

			/**
			 * One pump for both queues: a frame drains the text queue and the attribute queue.
			 *
			 * It owns its OWN flag. It used to share `L.pending` with the observer's scan frame,
			 * and that sharing was a silent stall, not a style question: when a scan frame was
			 * already in the air, `pump()` returned early, the scan frame ran `scanRoots()` only,
			 * and everything enqueued in that window sat in the queue until some LATER mutation
			 * happened to pump again. Measured by the 0.8 attribute check's timeline:
			 * `q:1, att:0, def:0, inj:0` for a full second, with a fixture that had stopped
			 * changing — i.e. with nothing left to trigger the next pump. A queue nobody drains is
			 * the "silent no-op" this project refuses, in its most literal form.
			 */
			function pump() {
				if (L.pending) return;
				L.pending = true;
				nextFrame(() => { L.pending = false; flush(); flushAttrs(); });
			}

			function schedule(node) {
				if (L.queue.length < 500 && !L.queue.includes(node)) L.queue.push(node);
				pump();
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
						const key = keyOfRaw(text);                                 // masked: the key the write path used
						const cached = L.cache.get(key);
						// "The app wrote the ORIGINAL back": the node carries the source, not our
						// translation. Compared against the RECORD, not against the cache value —
						// since §6.1 the cached text is masked and cannot be compared to a node.
						const carriesSource = !rec || text === rec.source;
						// No cache entry: an untrusted surface keeps none. The block memory still
						// remembers what we showed, so the anti-flicker path stays a zero-call repair
						// instead of a new paid request.
						if (cached === undefined && carriesSource) {
							const mem = node.parentElement && L.hosts.get(node.parentElement);
							if (mem && mem.translation !== undefined && mem.source === text) {
								const hold = L.held.get(key) || { count: 0, until: 0 };
								hold.count += 1;
								if (hold.count > 2) { hold.until = now() + GIVE_UP_MS; L.held.set(key, hold); L.counters.giveUps += 1; }
								else {
									L.held.set(key, hold);
									L.counters.reinjections += 1;
									if (!L.counters.englishSince.has(node)) L.counters.englishSince.set(node, now());
									inject(node, mem.translation, surfaceOf(node));
								}
								continue;
							}
						}
						if (cached !== undefined && carriesSource) {
							const hold = L.held.get(key) || { count: 0, until: 0 };
							hold.count += 1;
							if (hold.count > 2) {                                   // give up: stable English beats a strobe
								hold.until = now() + GIVE_UP_MS; L.held.set(key, hold);
								L.counters.giveUps += 1; L.cache.delete(key);
							} else {
								L.held.set(key, hold);
								const restored = unmaskTokens(cached, maskTokens(text).tokens);
								if (restored.missing.length || restored.leaked) { L.cache.delete(key); continue; }
								L.counters.reinjections += 1;
								if (!L.counters.englishSince.has(node)) L.counters.englishSince.set(node, now());
								inject(node, restored.text, surfaceOf(node), key);  // FROM CACHE: no engine call
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
				// The scan frame keeps ITS OWN flag, and it DRAINS like the pump does. The owner of
				// this invariant is the frame, not the caller: "no frame ends with work queued".
				//
				// ح-24 was the other shape — a scan frame that only scanned, so a pump swallowed by it
				// left the queue with nobody to drain it. Separating the flags fixed that; draining in
				// BOTH frames makes it structurally impossible, and gives the CI a provable guard:
				// check 16 puts work in the queue without arming a pump, arms this frame, and requires
				// the queue to be empty afterwards. An independent verification showed the older
				// "swallowed pump" check could not prove anything here, precisely because the cure had
				// already made the failure unreachable.
				if (rootsMayHaveChanged && !L.scanPending) {
					L.scanPending = true;
					nextFrame(() => { L.scanPending = false; scanRoots(); flush(); flushAttrs(); notify(); });
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
			function markSurface(el, id, origin) {
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
				el.setAttribute(SURFACE_ATTR, id); el.setAttribute(SURFACE_FROM, origin || "slot");
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
					// NESTED surfaces are the normal case on a live GUI, not an edge case: every
					// tool row (`[data-tool]`) sits INSIDE the conversation root
					// (`[data-conversation-content]`), and the document preview sits inside the
					// panel root. The innermost declared surface owns a text node — `surfaceOf`
					// reads it back with `closest()` — so an outer root must never stop an inner
					// one from being marked.
					//
					// This WAS wrong, and an assertion caught it rather than a live GUI: the old
					// rule ("skip if any marked ancestor exists") meant the 73 tool rows were
					// never marked at all, so their text was translated under the `replies` key
					// and the `tools` key controlled nothing. Measured before the fix:
					// `الصفّ إنجليزي والمفتاح مطفأ=false · السطح المنسوب=replies`.
					el.setAttribute(SURFACE_ATTR, s.id);
					el.setAttribute(SURFACE_FROM, origin);
					n += 1;
				}
				return n;
			}

			/**
			 * Re-derive the registry and fold it into the live state. New seats get keys; seats that
			 * went away lose theirs and hand their text back. Keys are per IDENTITY, so a
			 * virtualized list with two hundred rows is one key with `roots = 200`, not two hundred
			 * switches — and a panel that appears after boot enters here, from the mutation the
			 * observer already reported (no reload, no manual scan: the owner's rule 4).
			 *
			 * Throttled because it runs from the frame pump: the DOM is not re-read more than a few
			 * times a second, and the ledger is asked once per sync.
			 */
			function syncRegistry() {
				if (!registryMode || !L.slots) return 0;
				const t = now();
				if (t - L.registryAt < 200) return 0;
				L.registryAt = t;
				const entries = buildRegistry(L.slots);
				const seen = new Set();
				for (const e of entries) {
					seen.add(e.id);
					const cur = L.state[e.id];
					if (!cur) {
						const override = L.keys.has(e.id) ? L.keys.get(e.id) : e.on;
						L.state[e.id] = { ...e, on: override, roots: 0, attrTargets: 0 };
					} else {
						// identity facts refresh; the user's own switch does NOT (it outlives a sync)
						cur.label = e.label; cur.selector = e.selector; cur.owner = e.owner;
						cur.trust = e.trust; cur.kind = e.kind;
					}
				}
				for (const id of Object.keys(L.state)) {
					if (seen.has(id)) continue;
					// A surface the SHELL handed us (`translateElement` on an element that matches no
					// registry identity) is not derived from the DOM, so a sync cannot say it is gone:
					// deleting it here would restore the translation 200 ms after the click. It lives
					// until its element leaves the document, or the user restores it.
					if (L.state[id].kind === "handed") {
						if (document.querySelector("[" + SURFACE_ATTR + '="' + id + '"]')) continue;
					}
					// The seat is gone (a panel was closed): its translations go back and its key
					// disappears with it. A key that outlives its surface is a lie in the panel.
					if (L.state[id].roots || L.state[id].attrTargets) restoreSurface(id);
					delete L.state[id];
				}
				return entries.length;
			}

			function scanRoots() {
				syncRegistry();
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
				let attrs = 0;
				for (const id of wanted) {
					const s = L.state[id];
					if (!s || !s.on) continue;
					s.attrTargets = 0;                        // a fresh reading, per pass — never a carried-over number
					for (const el of document.querySelectorAll("[" + SURFACE_ATTR + '="' + id + '"]')) {
						if (el.closest(IGNORE)) continue;
						const nodes = [];
						textNodesIn(el, nodes, 400);
						for (const node of nodes) { if (eligible(node) && !L.records.has(node)) { schedule(node); scheduled += 1; } }
						const queued = scheduleAttrsIn(el, id);
						s.attrTargets += queued;
						attrs += queued;
					}
				}
				notify();
				return scheduled + attrs;
			}

			/**
			 * Translate ONE element the shell handed us through a seat — the GENERAL path (0.8).
			 *
			 * Why this exists, in the owner's words: «الاضافة عامة وليست لنا فقط … نريد حل مبتكر
			 * مثل الزر المحقون في لوحة الاعدادت يعمل مع كل تبويب بسلاسة». A selector list can only
			 * ever cover the panels that existed when it was written; a seat covers every panel
			 * that will ever exist, because the shell — not us — decides what a panel is and hands
			 * us a control inside it. This is the settings row's trick, generalised: we do not
			 * guess the container, we are placed inside it and we walk from our own position.
			 *
			 * The explicit click IS the declaration (same precedent as the settings row): the
			 * surface's key is turned on by the act of asking for that panel, and only THAT
			 * element is translated — not every panel on the page.
			 */
			function translateElement(el, surfaceId) {
				if (!el) return 0;
				let id = surfaceId || null;
				if (id && !L.state[id]) {
					// An identity the shell handed us that the registry has not seen: create it on the
					// spot. This is the general case (a seat mounted after boot, a panel we cannot
					// attribute) and it must not fail — a handed element IS a surface.
					L.state[id] = { id, label: id, selector: null, on: true, trust: "untrusted", owner: null, roots: 0, attrTargets: 0, kind: "handed", verified: true };
				}
				if (!id) {
					for (const s of Object.values(L.state)) {
						if (!s.selector) continue;
						try { if (el.matches(s.selector) || el.closest(s.selector)) { id = s.id; break } } catch { /* a bad selector is not a crash */ }
					}
					if (!id) {
						id = "seat:handed";
						if (!L.state[id]) L.state[id] = { id, label: "مقعد من الشل", selector: null, on: true, trust: "untrusted", owner: null, roots: 0, attrTargets: 0, kind: "handed", verified: true };
					}
				}
				const s = L.state[id];
				if (!s) return 0;
				s.on = true;                                        // explicit intent, like the settings row
				markSurface(el, id, "seat");
				let scheduled = 0;
				const nodes = [];
				textNodesIn(el, nodes, 400);
				for (const node of nodes) { if (eligible(node) && !L.records.has(node)) { schedule(node); scheduled += 1; } }
				const attrs = scheduleAttrsIn(el, id);
				s.attrTargets = (s.attrTargets || 0) + attrs;
				notify();
				return scheduled + attrs;
			}

			/** Does this element hold OUR translations right now? The seat control's second face. */
			function translatedInElement(el) {
				if (!el) return false;
				for (const [node, rec] of L.records) { if (el.contains(node) && isVisible(node)) return true }
				for (const [owner, rec] of L.attrs) { if (el.contains(owner) && isVisible(owner)) return true }
				return false;
			}

			/** Hand back the original text of ONE element — the seat control's undo. */
			function restoreElement(el) {
				if (!el) return 0;
				L.gen += 1;
				let restored = restoreAttrs(null, el);
				muted(() => {
					for (const [node, rec] of Array.from(L.records)) {
						if (!el.contains(node)) continue;
						if (node.isConnected && node.nodeValue === rec.translation) { node.nodeValue = rec.source; restored += 1; }
						dropRecord(node, rec);
					}
				});
				notify();
				return restored;
			}

			function restoreAll() {
				L.gen += 1;                                              // late results are now dead
				L.queue.length = 0;
				L.attrQueue.length = 0;
				abortInflight();                                         // and the host stops generating for a reader who left
				let restored = 0;
				restored += restoreAttrs(null);                          // attributes: never inside muted() (rule 11)
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
				restored += restoreAttrs(id);           // attributes first, and outside muted() (rule 11)
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
				L.attrQueue.length = 0;
				abortInflight();               // and nothing in flight may still spend the user's tokens
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
				abortInflight();                 // an unloaded plugin must not keep a paid call running
				restoreAll();
			}

			/** Change the target language: the cache key changes with it, so nothing stale survives. */
			function setTarget(code) {
				const next = String(code || "ar").slice(0, 8);
				if (!TARGETS.some((t) => t.code === next)) return;
				if (next === L.target) return;
				L.target = next;
				ENGINE_STATE.target = next;
				try { localStorage.setItem("dct-target", next) } catch { /* private mode: keep it for this page */ }
				restoreAll();                       // what is on screen belongs to the old language
				notify();
			}

			/**
			 * The one definition of "work is in flight". The spinner, the progress line and the CI
			 * check all read THIS — a second inline copy is how a guard stops being guarded
			 * (audit ح-28: removing the spinner's getter broke the live UI and every check passed).
			 */
			function busyNow() {
				return L.inflight > 0 || L.blocksWaiting > 0 || L.queue.length > 0 || L.attrQueue.length > 0;
			}

			const api = {
				state: L.state, counters: L.counters,
				get loopFlag() { return L.loopFlag }, get debug() { return L.debug },
				get diagnostics() { return L.diagnostics },
				get inflight() { return L.inflight },
				/**
				 * True while anything is queued, waiting on segments, or waiting on the engine —
				 * the spinner's input. The attribute queue is part of it: a panel whose titles are
				 * still being translated IS busy, and a progress line that ignored them would be
				 * the "timer that lies" this project refused in 0.5.
				 */
				get busy() { return busyNow() },
				/** The progress panel's own numbers, each one a live reading rather than a stored total. */
				get progress() {
					return {
						inflight: L.inflight, blocksWaiting: L.blocksWaiting,
						queued: L.queue.length, attrsQueued: L.attrQueue.length,
						segmentsPending: L.segPending.size,
						// ONE source for "is work in flight": the spinner (`busy`) and the progress
						// line (`progress.busy`) must not be able to disagree. They were two inline
						// expressions until an independent verification showed that removing the
						// spinner's getter broke the live UI and no check could see it (audit ح-28).
						busy: busyNow()
					};
				},
				/** Attribute records, read-only: how many `title`/`aria-label` values are ours right now. */
				get attributeCount() { return L.attrs.size },
				/**
				 * True once this layer is holding translations ON SCREEN — the header button's
				 * second face. Counted from the records and their visibility, never from a flag
				 * we maintain by hand: a flag can lie, a count from the DOM cannot.
				 */
				get translated() { return countTranslated(null) > 0 },
				/** The same question for ONE surface: the settings window's own buttons. */
				translatedIn: (id) => countTranslated(id) > 0,
				translatedCount: (id) => countTranslated(id),
				get target() { return L.target },
				/** The segment cache, read-only from outside: what 0.6 caches on (§6.1). */
				get segments() { return L.segments },
				setTarget,
				translateRoots, restoreAll, restoreSurface, cancel, setSurface, clearCache,
				scanRoots, markSurface, note, discover, dispose,
				/* The seat-driven path (0.8): a control the SHELL placed inside somebody else's
				   panel asks for exactly that panel — no selector, no plugin name. */
				translateElement, restoreElement, translatedInElement, syncRegistry, rekeyModel: (m) => L.rekeyModel(m),
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
					const signal = options && options.signal;
					let res
					try {
						res = await fetch(ROUTE + "/translate", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ segments: texts, target: (options && options.target) || state.target }),
							signal
						})
					} catch (error) {
						// An aborted fetch is the user's own cancel travelling to the host, not a
						// transport failure — naming it TRANSPORT would put a red line on the
						// screen for something the user just asked for.
						const aborted = String((error && error.name) || "") === "AbortError"
						const e = new Error(aborted ? "أُلغي الطلب (استرجاع أو إلغاء من المستخدم)" : "تعذّر الوصول إلى مسار المحرّك في المضيف")
						e.code = aborted ? "ABORTED" : "TRANSPORT"
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
/* The design tokens are scoped to OUR panel, never to :root: this stylesheet is injected into
   somebody else's page, and a global --accent would be a collision waiting to happen. */
.dct-panel {
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  --text-primary: light-dark(#0f172a, #f1f5f9);
  --text-secondary: light-dark(#475569, #94a3b8);
  --text-tertiary: light-dark(#94a3b8, #64748b);
  --card-bg: light-dark(rgba(255,255,255,.94), rgba(18,20,26,.92));
  --card-border: light-dark(rgba(226,232,240,.9), rgba(255,255,255,.08));
  --card-shadow: light-dark(0 20px 45px -10px rgba(15,23,42,.12), 0 25px 50px -12px rgba(0,0,0,.65));
  --subtle-bg: light-dark(rgba(241,245,249,.7), rgba(255,255,255,.03));
  --subtle-border: light-dark(rgba(203,213,225,.5), rgba(255,255,255,.06));
  --accent: light-dark(#2563eb, #3b82f6);
  --accent-hover: light-dark(#1d4ed8, #2563eb);
  --accent-glow: light-dark(rgba(37,99,235,.16), rgba(59,130,246,.25));
  --accent-text: #ffffff;
  --warn-bg: light-dark(#fffbeb, rgba(245,158,11,.08));
  --warn-border: light-dark(#fef3c7, rgba(245,158,11,.2));
  --warn-text: light-dark(#b45309, #fbbf24);
  --bad-bg: light-dark(#fef2f2, rgba(239,68,68,.08));
  --bad-border: light-dark(#fee2e2, rgba(239,68,68,.2));
  --bad-text: light-dark(#b91c1c, #f87171);
  --success-bg: light-dark(#f0fdf4, rgba(34,197,94,.08));
  --success-border: light-dark(#dcfce7, rgba(34,197,94,.2));
  --success-text: light-dark(#15803d, #4ade80);
  --radius-lg: 16px; --radius-md: 10px; --radius-sm: 6px;
  position: fixed; inset-block-start: 60px; inset-inline-end: 24px; z-index: 999998;
  width: min(420px, 94vw); max-height: 84vh; overflow-y: auto; overflow-x: hidden;
  background: var(--card-bg); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
  color: var(--text-primary); border: 1px solid var(--card-border); border-radius: var(--radius-lg);
  box-shadow: var(--card-shadow); padding: 18px 20px; text-align: start;
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
}
/* The same panel, two seats: the header popover (fixed) and the shell's main area (0.8).
   Embedded it fills the pane instead of floating over the conversation, because the 0.8
   acceptance test reads it WHILE a live stream runs — a readout you must close to see the
   stream is not a readout. */
.dct-panel.dct-embedded { position: static; inset: auto; width: auto; max-height: none;
  box-shadow: none; border: none; border-radius: 0; background: transparent; padding: 16px;
  backdrop-filter: none; -webkit-backdrop-filter: none; }
.dct-header-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; gap: 10px; }
.dct-brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dct-brand-icon { width: 24px; height: 24px; border-radius: 6px; background: var(--accent-glow);
  color: var(--accent); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.dct-glyph { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; }
.dct-title { font-size: 13.5px; font-weight: 700; color: var(--text-primary); margin: 0; line-height: 1.2; letter-spacing: -.01em; }
.dct-badge-model { display: inline-flex; align-items: center; gap: 4px; background: var(--subtle-bg);
  border: 1px solid var(--subtle-border); border-radius: 999px; padding: 2px 8px; font-size: 10.5px;
  font-weight: 500; color: var(--text-secondary); font-family: var(--font-mono); max-width: 190px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dct-bar { display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: stretch; margin-bottom: 12px; }
.dct-primary { display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  min-height: 38px; padding: 0 16px; background: var(--accent); color: var(--accent-text);
  border: 1px solid transparent; border-radius: var(--radius-md); font-size: 13px; font-weight: 600;
  cursor: pointer; box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 2px 8px var(--accent-glow);
  transition: background .15s cubic-bezier(.4,0,.2,1), transform .15s cubic-bezier(.4,0,.2,1); }
.dct-primary:hover { background: var(--accent-hover); transform: translateY(-.5px); }
.dct-primary:active { transform: translateY(0); }
.dct-lang-box { display: inline-flex; align-items: center; gap: 6px; background: var(--subtle-bg);
  border: 1px solid var(--card-border); border-radius: var(--radius-md); padding: 2px 8px 2px 10px; }
.dct-lang-box:hover, .dct-lang-box:focus-within { border-color: var(--accent); }
.dct-lang-box label { font-size: 11px; font-weight: 600; color: var(--text-tertiary); user-select: none; }
.dct-select { border: none; background: transparent; color: var(--text-primary); font-family: inherit;
  font-size: 12.5px; font-weight: 600; padding: 4px 2px; cursor: pointer; outline: none; }
.dct-status { min-height: 34px; padding: 6px 12px; border-radius: var(--radius-md); font-size: 12px;
  display: flex; align-items: center; gap: 8px; margin-bottom: 12px; border: 1px solid transparent; }
.state-idle .dct-status { background: var(--subtle-bg); border-color: var(--subtle-border); color: var(--text-secondary); }
.state-working .dct-status { background: var(--warn-bg); border-color: var(--warn-border); color: var(--warn-text); }
.state-done .dct-status { background: var(--success-bg); border-color: var(--success-border); color: var(--success-text); }
.state-fail .dct-status { background: var(--bad-bg); border-color: var(--bad-border); color: var(--bad-text); }
.dct-status .grow { flex: 1; min-width: 0; }
.status-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.state-idle .status-dot { background: var(--text-tertiary); }
.state-working .status-dot { background: var(--warn-text); animation: dct-pulse 1.2s infinite ease-in-out; }
.state-done .status-dot { background: var(--success-text); }
.state-fail .status-dot { background: var(--bad-text); }
@keyframes dct-pulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .4; transform: scale(.85); } }
.dct-metrics-pill { display: inline-flex; align-items: center; gap: 6px; font-family: var(--font-mono);
  font-size: 11.5px; font-weight: 600; flex-wrap: wrap; }
.dct-more { border-top: 1px solid var(--card-border); padding-top: 10px; margin-top: 6px; }
.dct-more > summary { display: flex; align-items: center; justify-content: space-between; cursor: pointer;
  font-size: 12px; font-weight: 600; color: var(--text-secondary); user-select: none; padding: 6px 4px;
  border-radius: var(--radius-sm); list-style: none; }
.dct-more > summary:hover { color: var(--text-primary); }
.dct-more > summary::-webkit-details-marker { display: none; }
.dct-more-toggle-icon { display: inline-flex; align-items: center; transition: transform .2s ease; }
.dct-more[open] .dct-more-toggle-icon { transform: rotate(180deg); }
.dct-sec { margin-top: 12px; padding: 10px 12px; background: var(--subtle-bg);
  border: 1px solid var(--subtle-border); border-radius: var(--radius-md); }
.dct-sec.dct-plain { background: transparent; border: none; padding: 4px 0 0; }
.dct-sec-title { font-size: 11px; text-transform: uppercase; font-weight: 700; letter-spacing: .05em;
  color: var(--text-tertiary); margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dct-counter-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 12px; }
.dct-kv { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11.5px; padding: 3px 0; }
.dct-kv span { color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dct-kv b { font-family: var(--font-mono); font-size: 11.5px; font-weight: 600; color: var(--text-primary); font-variant-numeric: tabular-nums; }
.dct-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 0;
  border-top: 1px dashed var(--subtle-border); font-size: 12px; }
.dct-row:first-of-type { border-top: none; }
.dct-row label { display: flex; align-items: center; gap: 7px; cursor: pointer; font-weight: 500; min-width: 0; }
.dct-row input[type="checkbox"] { accent-color: var(--accent); cursor: pointer; }
.dct-row-val { display: flex; align-items: center; gap: 8px; font-family: var(--font-mono); font-size: 11px; flex-shrink: 0; }
.dct-note { font-size: 11.5px; color: var(--text-tertiary); line-height: 1.5; }
.dct-warn { color: var(--warn-text); }
.dct-bad { color: var(--bad-text); font-weight: 600; font-size: 11.5px; line-height: 1.5; }
.dct-btn { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 28px;
  padding: 0 10px; border: 1px solid var(--subtle-border); border-radius: var(--radius-sm);
  background: var(--card-bg); color: var(--text-primary); font-family: inherit; font-size: 11.5px;
  font-weight: 500; cursor: pointer; transition: border-color .15s ease, background .15s ease, transform .15s ease; }
.dct-btn:hover { border-color: var(--card-border); background: var(--subtle-bg); transform: translateY(-.5px); }
.dct-btn.dct-mini { height: 22px; padding: 0 8px; font-size: 10.5px; border-radius: 5px; }
.dct-btn.dct-icon { width: 28px; padding: 0; }
.dct-btn.dct-bare { border: none; background: transparent; color: var(--text-tertiary); }
.dct-btn[data-on] { background: var(--accent-glow); border-color: var(--accent); color: var(--accent); }
.dct-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.dct-tech-line { font-family: var(--font-mono); font-size: 10px; color: var(--text-tertiary);
  background: var(--subtle-bg); border: 1px solid var(--subtle-border); border-radius: 4px; padding: 4px 8px;
  margin-top: 6px; user-select: all; word-break: break-all; direction: ltr; text-align: left; }
.dct-spin { display: inline-block; width: 12px; height: 12px; border: 2px solid currentColor;
  border-top-color: transparent; border-radius: 50%; animation: dct-rot .75s linear infinite; flex-shrink: 0; }
/* The page chip: OUR control for somebody else's PAGE (logcat, mnemon … — measured: they register
   a page in the shell's main seat via ctx.slots.inject("main", …), and while such a page is up the
   conversation is not even in the DOM, so the header button has nothing to aim at). It floats over
   the page's top-right corner instead of being inserted into the plugin's markup: no React
   re-render can remove it, and nothing of theirs is touched. Its colours are its own — it lives
   outside .dct-panel, so the panel's tokens cannot reach it. */
.dct-chip { position: fixed; z-index: 999997; width: 26px; height: 26px; padding: 0; display: inline-flex;
  align-items: center; justify-content: center; border-radius: 7px; cursor: pointer;
  border: 1px solid light-dark(rgba(15,23,42,.16), rgba(255,255,255,.16));
  background: light-dark(rgba(255,255,255,.92), rgba(18,20,26,.9));
  color: light-dark(#334155, #cbd5e1); box-shadow: 0 1px 3px rgba(0,0,0,.18);
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); transition: color .15s ease, border-color .15s ease; }
.dct-chip:hover { color: light-dark(#2563eb, #60a5fa); border-color: currentColor; }
.dct-chip[data-busy] { color: light-dark(#b45309, #fbbf24); border-color: currentColor; }
.dct-chip svg { display: block; }
@keyframes dct-rot { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .dct-spin { animation-duration: 2s; } .state-working .status-dot { animation: none; } }
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
			// The page this control lives in, walked from our own position — no selector, no plugin
			// name — and translated through the SEAT path (`translateElement`), which is the path
			// that DECLARES a surface. Measured on the owner's GUI: the icon rendered and pressing it
			// left `requests` at 0 with no `settings` key in the registry at all, because
			// `markSurface` requires the id to exist and `setSurface` returns silently when it does
			// not. An id-based «settings» surface is a dead path in this shell.
			const targetOf = () => pageAncestor(ref.current ? ref.current.parentElement : null, "settings");
			const translated = props.layer.translatedInElement(targetOf());
			const act = () => {
				const el = targetOf();
				if (!el) { props.layer.note("زرّ الإعدادات: لم أجد الصفحة الحاوية له"); return; }
				if (props.layer.translatedInElement(el)) props.layer.restoreElement(el);
				else props.layer.translateElement(el);
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
			// Same act and same path as the icon above (see its note): the row declares the surface
			// by asking for it, and only the page it sits in is translated.
			const targetOf = () => pageAncestor(ref.current ? ref.current.parentElement : null, "settings");
			const translated = props.layer.translatedInElement(targetOf());
			const act = () => {
				const el = targetOf();
				if (!el) { props.layer.note("صفّ الإعدادات: لم أجد الصفحة الحاوية له"); return; }
				if (props.layer.translatedInElement(el)) props.layer.restoreElement(el);
				else props.layer.translateElement(el);
			};
			return h("div", { className: "dct-settings-row", "data-dct-ignore": "", ref },
				h("span", { className: "dct-settings-label" }, busy ? "جارٍ ترجمة الإعدادات…" : (translated ? "استرجاع نصّ الإعدادات" : "ترجمة محتوى الإعدادات")),
				button(busy ? h(Spinner) : translateIcon(), act, {
					className: "dct-btn dct-icon",
					"data-on": translated ? "1" : undefined,
					title: busy ? "جارٍ الترجمة…" : (translated ? "استرجاع الأصل" : "ترجم محتوى الإعدادات"),
					"aria-label": busy ? "جارٍ الترجمة" : (translated ? "استرجاع الأصل" : "ترجم محتوى الإعدادات")
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

		/**
		 * The sidebar row's glyph (0.8). `sidebar.panellist` renders the row chrome and the
		 * label itself and hands this component `{ size, active }`, so the component owns the
		 * mark and nothing else — plus the ring while work is in flight, which is the one thing
		 * the row can say that its label cannot.
		 */
		function PanelIcon(props) {
			const busy = useBusy(props.layer, props.subscribe);
			return h("span", { className: "dct-glyph", "data-dct-ignore": "", "aria-hidden": "true" },
				busy ? h(Spinner) : translateIcon());
		}

		/** Re-render a control while the layer is working, so the ring appears with the work. */
		function useBusy(layer, subscribe) {
			const [, bump] = useState(0);
			useEffect(() => (subscribe ? subscribe(() => bump((n) => n + 1)) : undefined), []);
			return !!layer.busy;
		}

		/**
		 * Resolve the DOM body of a shell tab from the tab the SHELL handed us: the tab id is the
		 * shell's own identity, and the shell marks the body with it (`data-dockkit-content`,
		 * `data-sidebar-right-tab`) and the strip with `data-dockkit-tab`. Measured on a live GUI.
		 * A panel written tomorrow works here without a line of code, which is the entire point.
		 */
		function tabBodyOf(tab) {
			const id = tab && (tab.id || tab.key || tab.tabId);
			if (!id) return null;
			const sel = '[data-dockkit-content="' + id + '"], [data-sidebar-right-tab="' + id + '"], [data-dockkit-tab="' + id + '"]';
			let best = null;
			let found = [];
			try { found = document.querySelectorAll(sel) } catch { return null }
			for (const el of found) {
				if (el.closest(IGNORE)) continue;
				if (!best || el.querySelectorAll("*").length > best.querySelectorAll("*").length) best = el;
			}
			return best;
		}

		/**
		 * One row in a tab's own menu, rendered by the shell for every tab there is. The menu is a
		 * portal, so this row is marked `data-dct-ignore`: our own UI is never a translation
		 * target (PLAN.md §5 rule 8).
		 */
		function TabMenuItem(props) {
			const body = props.tab ? tabBodyOf(props.tab) : null;
			if (!body) return null;                       // nothing to offer: no row, rather than a dead one
			const done = props.layer.translatedInElement(body);
			return h("button", {
				className: "dct-menuitem", "data-dct-ignore": "", type: "button",
				onClick: () => {
					if (props.layer.translatedInElement(body)) props.layer.restoreElement(body);
					else props.layer.translateElement(body);      // the layer derives the identity from the element
					if (typeof props.dismiss === "function") props.dismiss();
				}
			}, done ? "استرجاع أصل هذه اللوحة" : "ترجم محتوى هذه اللوحة");
		}

		/** The panel: state, counters, surface switches with a live probe, and the actions. */
		/**
		 * The panel's own chrome, in two languages.
		 *
		 * The owner's design («Modern Craft Edition») ships RTL and LTR side by side — «جعلته يقبل
		 * ltr ايضا للمستقبل» — so the direction and the wording follow the INTERFACE language here
		 * too, and the panel's own dir attribute comes from the same place. The probe lines stay LTR
		 * whatever the direction is: they are identifiers, not prose.
		 */
		const PANEL_STRINGS = {
			ar: {
				title: "ترجمة المحتوى",
				translate: "ترجم هذا المحتوى", working: "جارٍ الترجمة…", restore: "استرجاع الأصل", retry: "إعادة المحاولة",
				to: "إلى", close: "إغلاق", idle: "جاهز — لا توجد مهام ترجمة جارية.",
				workingLine: (a, q, attrs) => "جارٍ: " + a + " · في الطابور: " + q + (attrs ? " · سمات: " + attrs : ""),
				done: (calls, inj, tokens) => "تمّ: " + calls + " نداء · " + inj + " حقنة · توكنات " + tokens,
				unknown: "غير معروف", details: "التفاصيل والعدّادات الميدانية", metrics: "مؤشرات الأداء والكاش",
				surfaces: "سجلّ الأسطح المستهدفة",
				surfacesTotals: (all, on, roots) => all + " سطحًا · " + on + " مُفعَّلًا · " + roots + " مستهدفًا",
				quiet: (n) => "و" + n + " سطحًا آخر بلا جذر في هذه اللحظة (عدد مقيس، لا أسماء مخفيّة).",
				noRoots: "لا سطح واحد مطابق الآن: هذا قياس، لا عطل صامت — أبلغ به كما هو.",
				translateOne: "ترجم", hostLog: "سجلّ نداءات المضيف (ميتاداتا فقط)", readLog: "اقرأ",
				notRead: "لم يُقرأ بعد — الزرّ يقرأ ميتاداتا (أحرف/موديل/مللي/توكنات)، ولا يقرأ نصًّا.",
				hostTotals: (t) => "إجمالي: " + t.calls + " نداء · " + t.segments + " مقطعًا · " + t.chars + " حرفًا · توكنات " + t.inputTokens + "/" + t.outputTokens + " · فشل " + t.failed,
				cancel: "إلغاء", clearCache: "تفريغ الكاش",
				batching: (seg, chars) => "الدفعات: حتى " + seg + " مقاطع أو " + chars + " حرفًا في النداء الواحد، بفاصل مُرقَّم؛ وفشل المحاذاة يُرمى ولا يُخزَّن.",
				loop: "حلقة مشتبهة: أُوقفت الطبقة (أكثر من 300 حقن في ثانية).",
				labelCalls: "نداءات المحرّك", labelSegments: "مقاطع أُرسلت / من الكاش", labelTokens: "توكنات الدخل / الخرج",
				labelMs: "كلفة آخر نداء", labelAlign: "فشل محاذاة / دفعات", labelInject: "حقن نصّي / سمات",
				labelGiveUp: "استسلام / متأخّرة", labelFlicker: "وميض إنجليزي",
				footer: "المحرّك نموذج DSH في المضيف (ctx.llm.stream) — بلا خدمة خارجية وبلا مفتاح ثانٍ. الكاش بالمحتوى، والأسطح غير الموثوقة بلا تخزين دائم، وسجلّ المضيف ميتاداتا فقط."
			},
			en: {
				title: "Translate This",
				translate: "Translate this content", working: "Translating…", restore: "Restore original", retry: "Retry",
				to: "To", close: "Close", idle: "Ready — no translation in flight.",
				workingLine: (a, q, attrs) => "working: " + a + " · queued: " + q + (attrs ? " · attrs: " + attrs : ""),
				done: (calls, inj, tokens) => "done: " + calls + " call(s) · " + inj + " injection(s) · tokens " + tokens,
				unknown: "unknown", details: "Field details and counters", metrics: "Performance and cache",
				surfaces: "Target surfaces registry",
				surfacesTotals: (all, on, roots) => all + " surfaces · " + on + " enabled · " + roots + " target(s)",
				quiet: (n) => "and " + n + " more surfaces with no root right now (a measured count, not hidden names).",
				noRoots: "No surface matches right now: that is a measurement, not a silent failure — report it as it is.",
				translateOne: "Translate", hostLog: "Host call log (metadata only)", readLog: "Read",
				notRead: "Not read yet — the button reads metadata (chars/model/ms/tokens), never text.",
				hostTotals: (t) => "total: " + t.calls + " call(s) · " + t.segments + " segment(s) · " + t.chars + " chars · tokens " + t.inputTokens + "/" + t.outputTokens + " · failed " + t.failed,
				cancel: "Cancel", clearCache: "Clear cache",
				batching: (seg, chars) => "Batches: up to " + seg + " segments or " + chars + " characters per call behind a numbered separator; an alignment failure is thrown away, never stored.",
				loop: "Suspected loop: the layer stopped itself (over 300 injections in a second).",
				labelCalls: "Engine calls", labelSegments: "Segments sent / cached", labelTokens: "Input / output tokens",
				labelMs: "Last call cost", labelAlign: "Alignment / batch failures", labelInject: "Text / attribute injections",
				labelGiveUp: "Give-ups / late drops", labelFlicker: "English flicker",
				footer: "The engine is the host's own DSH model (ctx.llm.stream) — no external service, no second key. Content-addressed cache, untrusted surfaces store nothing, and the host log is metadata only."
			}
		};

		/** Which language the panel speaks: the interface's, defaulting to Arabic. */
		function panelLang() {
			try {
				const lang = String((typeof document !== "undefined" && document.documentElement && document.documentElement.lang) || "ar").toLowerCase();
				return lang.startsWith("en") ? "en" : "ar";
			} catch { return "ar"; }
		}

		function Panel(props) {
			const layer = props.layer;
			const [, bump] = useState(0);
			const [hostLog, setHostLog] = useState(null);
			useEffect(() => (props.subscribe ? props.subscribe(() => bump((n) => n + 1)) : undefined), []);
			/** Read the host's metadata log. Never the text: the host never stores it. */
			const readLog = () => {
				fetch(ROUTE + "/log?limit=6")
					.then((r) => r.json())
					.then((body) => setHostLog(body && body.ok ? body : { error: "host log unavailable" }))
					.catch(() => setHostLog({ error: "host log unreadable" }));
			};
			const c = layer.counters;
			const busy = useBusy(layer, props.subscribe);
			layer.scanRoots();
			// The registry can hold dozens of identities (every seat the shell renders), so the panel
			// leads with the ones that HAVE a root right now, counts the rest instead of hiding them,
			// and always reports the totals — a list that silently drops zeros is a list that lies.
			const all = Object.values(layer.state);
			const live = all.filter((s) => (s.roots || 0) > 0)
				.sort((a, b) => (Number(b.on) - Number(a.on)) || ((b.roots || 0) - (a.roots || 0)));
			const rows = live.concat(all.filter((s) => !(s.roots || 0)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, 24));
			const quiet = all.length - rows.length;
			const enabled = all.filter((s) => s.on).length;
			const totalRoots = all.reduce((a, s) => a + (s.roots || 0), 0);
			const lang = panelLang();
			const T = PANEL_STRINGS[lang];
			const dir = lang === "ar" ? "rtl" : "ltr";
			const tokens = c.usageCalls
				? (c.tokensIn + " / " + c.tokensOut)
				: (c.usageUnknown ? T.unknown + " (" + c.usageUnknown + ")" : T.unknown);
			// One state for the whole panel: the status colours, the message and the primary button's
			// face all read THIS, so they cannot disagree (the lesson of audit ح-28: two copies of one
			// state is how a guard stops being guarded).
			const state = busy ? "working" : (layer.debug ? "fail" : (c.requests > 0 ? "done" : "idle"));
			const icon = h("span", { className: "dct-glyph", "aria-hidden": "true" }, translateIcon());

			const header = h("div", { className: "dct-header-row" },
				h("div", { className: "dct-brand" },
					h("div", { className: "dct-brand-icon" }, icon),
					h("h2", { className: "dct-title" }, T.title)
				),
				h("span", { className: "dct-badge-model", title: props.engine.label },
					h("span", { style: { display: "inline-block", width: 5, height: 5, borderRadius: "50%", background: "var(--accent)" } }),
					h("span", null, props.engine.label)
				),
				props.onClose ? button("✕", () => props.onClose(), { className: "dct-btn dct-icon dct-bare", title: T.close, "aria-label": T.close }) : null
			);

			const primaryFace = busy
				? [T.working, h(Spinner)]
				: (layer.translated ? T.restore : (state === "fail" ? T.retry : T.translate));
			const bar = h("div", { className: "dct-bar" },
				button([icon, h("span", null, primaryFace)],
					() => { if (layer.translated) layer.restoreAll(); else layer.translateRoots() },
					{ className: "dct-btn dct-primary" }),
				h("div", { className: "dct-lang-box" },
					h("label", { htmlFor: "dct-target" }, T.to),
					h("select", {
						id: "dct-target", className: "dct-select", value: layer.target, "data-dct-ignore": "",
						onChange: (e) => layer.setTarget(e.target.value)
					}, TARGETS.map((t) => h("option", { key: t.code, value: t.code }, t.label)))
				)
			);

			// The status line: every number is a live reading from the layer, never a timer — and the
			// progress numbers and the failure line are exactly what the acceptance page reads.
			const workingLine = h("div", { className: "dct-metrics-pill grow" },
				h("span", null, T.workingLine(layer.progress.inflight, layer.progress.queued, layer.progress.attrsQueued)),
				layer.progress.segmentsPending ? h("span", null, "· " + layer.progress.segmentsPending) : null
			);
			const statusText = layer.debug
				? h("span", { className: "dct-bad grow" }, layer.debug)
				: h("span", { className: "dct-note grow" }, state === "done" ? T.done(c.requests, c.injections, tokens) : T.idle);
			const status = h("div", { className: "dct-status" }, h("span", { className: "status-dot" }), busy ? workingLine : statusText);

			const kv = (label, value) => h("div", { className: "dct-kv" }, h("span", null, label), h("b", null, value));
			const metricsSec = h("div", { className: "dct-sec" },
				h("div", { className: "dct-sec-title" }, h("span", null, T.metrics)),
				h("div", { className: "dct-counter-grid" },
					kv(T.labelCalls, c.requests + (c.batchCalls ? " · " + c.batchCalls : "")),
					kv(T.labelSegments, c.segmentsRequested + " / " + c.segmentHits),
					kv(T.labelTokens, tokens),
					kv(T.labelMs, c.lastCallMs ? c.lastCallMs + " ms" : "—"),
					kv(T.labelAlign, c.alignmentFailures + " / " + c.failedBatches),
					kv(T.labelInject, c.injections + " / " + c.attrInjections),
					kv(T.labelGiveUp, c.giveUps + " / " + c.droppedLate),
					kv(T.labelFlicker, Math.round(c.flickerMs) + " ms")
				)
			);

			const surfaceRow = (s) => h("div", { className: "dct-row", key: s.id },
				h("label", { title: s.id + (s.owner ? " · " + s.owner : "") },
					h("input", {
						type: "checkbox", checked: !!s.on, "data-dct-ignore": "",
						onChange: (e) => layer.setSurface(s.id, e.target.checked)
					}),
					" " + s.label + (s.owner ? " · " + String(s.owner).replace(/^@/, "").slice(0, 28) : "")
				),
				h("span", { className: "dct-row-val" },
					h("b", null, (s.roots || 0) + (s.attrTargets ? " + " + s.attrTargets : "") + " · " + tierLabel(s) +
						(s.kind === "handed" ? " ·" : "") + (s.trust === "untrusted" ? " ⌀" : "") + (s.trust === "chrome" ? " ⌂" : "")),
					button(T.translateOne, () => layer.setSurface(s.id, true), { className: "dct-btn dct-mini", title: T.translateOne })
				)
			);
			const surfacesSec = h("div", { className: "dct-sec" },
				h("div", { className: "dct-sec-title" },
					h("span", null, T.surfaces),
					h("b", { style: { fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-primary)" } },
						T.surfacesTotals(all.length, enabled, totalRoots))
				),
				totalRoots === 0 ? h("div", { className: "dct-note dct-warn" }, T.noRoots) : null,
				rows.map(surfaceRow),
				quiet > 0 ? h("div", { className: "dct-note", style: { marginTop: 6 } }, T.quiet(quiet)) : null
			);

			const logBody = !hostLog
				? h("div", { className: "dct-note" }, T.notRead)
				: (hostLog.error
					? h("div", { className: "dct-bad" }, hostLog.error)
					: [h("div", { className: "dct-note", key: "tot" }, T.hostTotals(hostLog.totals))]
						.concat(hostLog.calls.map((row, i) => h("div", { className: "dct-note", key: "hlog" + i, style: { userSelect: "all" } },
							(i + 1) + ". " + row.mode + " · " + row.segments + " · " + row.chars + " · " + row.ms + "ms · " +
							(row.ok ? "ok" : String(row.code)) + (row.attempts > 1 ? " · " + row.attempts : "") +
							(row.usage ? " · " + (row.usage.inputTokens ?? "?") + "/" + (row.usage.outputTokens ?? "?") : "")
						))));
			const logSec = h("div", { className: "dct-sec" },
				h("div", { className: "dct-row", style: { border: "none", padding: "0 0 6px" } },
					h("span", { style: { fontWeight: 600, fontSize: 11 } }, T.hostLog),
					button(T.readLog, readLog, { className: "dct-btn dct-mini" })
				),
				logBody,
				h("div", { className: "dct-note", style: { marginTop: 6 } }, T.batching(BATCH_SEGMENTS, BATCH_CHARS))
			);

			const probeLine = "probe: " + rows.map((s) => s.id + "(" + s.tier + ")=" + (s.roots || 0) + (s.markers ? "/m" + s.markers : "")).join(" · ");
			const toolsSec = h("div", { className: "dct-sec dct-plain" },
				h("div", { className: "dct-actions" },
					button(T.cancel, () => layer.cancel(), { className: "dct-btn dct-mini" }),
					button(T.clearCache, () => layer.clearCache(), { className: "dct-btn dct-mini" }),
					props.onClose ? button(T.close, () => props.onClose(), { className: "dct-btn dct-mini" }) : null
				),
				...(layer.diagnostics.map((d, i) => h("div", { className: "dct-bad", key: "d" + i, style: { marginTop: 6 } }, d))),
				// One copyable line each: the probe is the measurement, and a measurement that cannot
				// be quoted out of the GUI is a measurement nobody can check.
				h("div", { className: "dct-tech-line" }, probeLine),
				h("div", { className: "dct-tech-line" }, "dom: " + layer.discover().join(" · ")),
				h("div", { className: "dct-note", style: { marginTop: 6 } }, T.footer)
			);

			const summary = h("summary", null,
				h("span", null, T.details),
				h("span", { className: "dct-more-toggle-icon" },
					h("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "round", strokeLinejoin: "round" },
						h("polyline", { points: "6 9 12 15 18 9" }))
				)
			);
			const more = h("details", { className: "dct-more" }, summary, metricsSec, surfacesSec, logSec, toolsSec);

			return h("div", {
				className: "dct-panel state-" + state + (props.embedded ? " dct-embedded" : ""),
				"data-dct-ignore": "", dir, lang
			},
				header,
				bar,
				status,
				layer.loopFlag ? h("div", { className: "dct-status dct-bad" }, T.loop) : null,
				more
			);
		}

		const TIER_LABEL = { slot: "فتحة", selector: "مُحدِّد", fallback: "احتياطي", none: "لا شيء" };
		const tierLabel = (s) => TIER_LABEL[s && s.tier] || TIER_LABEL.none;

		/**
		 * The page the shell is showing that is NOT its own conversation — the rule 0.8 measured
		 * (`MAIN_PAGE_SELECTOR`) and the reason a plugin panel needs its own control: measured on a
		 * live GUI, when logcat's page sits in `main` the conversation is **not in the DOM at all**
		 * (`[data-conversation-content]` absent), so the header button has nothing to aim at.
		 */
		function pageRootOf(doc) {
			const target = doc || (typeof document !== "undefined" ? document : null);
			if (!target || !target.querySelector) return null;
			return target.querySelector(MAIN_PAGE_SELECTOR);
		}

		/**
		 * Where a page chip goes for a page box: its top-right corner, clamped so it can never leave
		 * the viewport (a control you cannot reach is not a control). Pure on purpose — the acceptance
		 * page has no React to mount the live widget with, but it can drive THIS with synthetic boxes.
		 */
		function chipPlacement(rect, viewport, size = 26, gap = 8) {
			if (!rect || !viewport) return null;
			const vw = Number(viewport.width) || 0;
			const vh = Number(viewport.height) || 0;
			if (!vw || !vh) return null;
			const right = Number(rect.right ?? ((Number(rect.left) || 0) + (Number(rect.width) || 0)));
			const top = Number(rect.top) || 0;
			return {
				top: Math.max(gap, Math.min(top + gap, vh - size - gap)),
				left: Math.max(gap, Math.min(right - size - gap, vw - size - gap))
			};
		}

		/** The chip's face, as markup we own: it is a raw DOM node, not a React element. */
		const CHIP_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="2"/><path d="M6 6.4h4.6M8.3 5.2v2.4M5.6 9.2l5 3.4M10.6 9.2l-5 3.4"/><rect x="10.5" y="11" width="11" height="10" rx="2"/><path d="M13.4 18.6l2.6-5.4 2.6 5.4M14.4 16.7h3.2"/></svg>';

		/**
		 * The header action: the owner asked for the icon instead of the sentence, so the
		 * face is the glyph and the sentence lives in `aria-label` + `title`. A control whose
		 * meaning only exists in a picture is a control nobody can read out loud.
		 */
		/**
		 * Close a floating panel when the user clicks anywhere OUTSIDE it, or presses Escape.
		 *
		 * The owner asked for exactly this («يجب أن تختفي عند الضغط بأي مكان غير نافذتها»), and it
		 * is a plain function on purpose: the acceptance page mounts the shipping module with no
		 * React at all (`require` returns `{}`), so a behaviour buried in a component hook can only
		 * be eyeballed there. As a function it is driven by real events in check 19 — click inside
		 * (must NOT close), click outside (must close), Escape (must close), and after the returned
		 * disposer nothing closes any more.
		 *
		 * @param root - the element that counts as "inside" (the button AND the panel it opened).
		 * @param onClose - called with no arguments when the user dismisses.
		 * @param doc - the document to listen on (injectable so the check can use its own).
		 * @returns the disposer that removes both listeners.
		 */
		function closeOnOutside(root, onClose, doc) {
			const target = doc || (typeof document !== "undefined" ? document : null);
			if (!target || typeof onClose !== "function") return () => {};
			const isOutside = (node) => {
				if (!root) return true;
				if (!node) return true;
				const el = node.nodeType === 3 ? node.parentNode : node;      // a text node's parent is the click target we care about
				return !(el && typeof el.nodeType === "number" && root.contains(el));
			};
			const onDown = (event) => { if (isOutside(event.target)) onClose(); };
			const onKey = (event) => { if (event.key === "Escape") onClose(); };
			target.addEventListener("mousedown", onDown, true);
			target.addEventListener("keydown", onKey, true);
			return () => {
				target.removeEventListener("mousedown", onDown, true);
				target.removeEventListener("keydown", onKey, true);
			};
		}

		function HeaderAction(props) {
			const [open, setOpen] = useState(false);
			const busy = useBusy(props.layer, props.subscribe);
			const translated = props.layer.translated;      // useBusy subscribes, so this stays fresh
			const box = useRef(null);
			// One button, two faces: press to translate, press again and the original text comes
			// back. The owner asked for exactly this, and it is the same restore the panel's
			// button performs — never a second implementation of "undo".
			const act = () => {
				if (props.layer.translated) props.layer.restoreAll();
				else props.layer.translateRoots();
				setOpen(true);
			};
			// The popover is dismissed by the user, not only by its own «إغلاق» button. The root is
			// the wrapper, so the trigger button and the panel are both "inside" and only a click
			// somewhere else in the page closes it.
			useEffect(() => {
				if (!open) return undefined;
				return closeOnOutside(box.current, () => setOpen(false));
			}, [open]);
			return h("span", { ref: box, style: { display: "inline-flex", gap: 6, alignItems: "center" } },
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
			let dock = null;
			let dockRoot = null;
			const syncDock = () => {
				const nativeSlotInDom = typeof document !== "undefined" &&
					!!document.querySelector('[data-slot="conversation.session.header.actions"]');
				if (nativeSlotInDom) {
					if (dock) {
						safe("dock:retire", () => {
							if (dockRoot) { try { dockRoot.unmount(); } catch {} dockRoot = null; }
							dock.remove();
							dock = null;
						});
					}
				} else if (!dock && typeof document !== "undefined" && document.body) {
					safe("dock:mount", () => {
						dock = document.createElement("div");
						dock.setAttribute("data-dct-ignore", "");
						dock.style.cssText = "position:fixed;inset-block-start:12px;inset-inline-end:12px;z-index:999998";
						document.body.appendChild(dock);
						dockRoot = createRoot(dock);
						dockRoot.render(h(HeaderAction, { layer, engine, subscribe }));
					});
				}
			};
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
			// NO surface table: the surfaces come from the runtime registry, whose sources are the
			// shell's seat ledger (`ctx.slots`) and the app's own markers. That is the whole point
			// of 0.8 — a table written here could only ever cover plugins that already existed.
			layer = createLayer({ engine, slots: ctx.slots, onChange: () => {
				for (const fn of listeners) { try { fn(); } catch { /* noop */ } }
				scheduleChip();
				syncDock();
			} });

			// The stylesheet and the status request are OURS and they outlive `apply()` unless
			// they are tracked: an independent harness measured the residue after running every
			// `ctx.effect` cleanup — `style[data-dct-style]` 1 → 1, and a `/status` fetch still in
			// the air whose late answer called `useStub` on a disposed layer (`notesAfterDispose:1`).
			let styleEl = null;
			safe("style", () => {
				const style = document.createElement("style");
				style.textContent = STYLE;
				style.dataset.dctStyle = "";
				document.head.appendChild(style);
				styleEl = style;
			});
			safe("first scan", () => layer.scanRoots());

			const statusAbort = typeof AbortController === "function" ? new AbortController() : null;

			// Is the host engine actually there? Measured, never assumed — and if it is not, the
			// fallback is a visible line in the panel and a label that says "stub", not a silence
			// that looks like a working translator.
			safe("engine status", () => {
				// A host without the engine is a visible line and a label that says "stub" — never a
				// silence that looks like a working translator. Both entry points move together: a
				// fallback that replaced `translate` only would leave the batch path calling a host
				// that is not there.
				const useStub = (why) => {
					if (statusAbort && statusAbort.signal.aborted) return;   // the plugin is gone; do not decorate a dead panel
					engine.translate = stubEngine.translate
					engine.translateBatch = stubEngine.translateBatch
					engine.label = stubEngine.label
					layer.note(why)
				}
				fetch(ROUTE + "/status", statusAbort ? { signal: statusAbort.signal } : undefined).then((r) => r.json()).then((body) => {
					if (statusAbort && statusAbort.signal.aborted) return;
					if (!body || body.engine !== "host") {
						useStub("المحرّك غير متاح في هذا المضيف (" + ((body && body.engine) || "لا استجابة") + ") — أترجم بمحرّك ثابت")
					} else {
						// The model and the prompt version ride in the cache key (§6.2): a key that
						// ignored them would serve one model's translation as another's.
						ENGINE_STATE.model = body.model || ""
						if (body.model && layer) layer.rekeyModel(body.model);
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

			// The progress panel as a tab in the right sidebar (0.8):
			// Registered in `sidebar.right.pane.tab` and `sidebar.right.pane.tab.title` so it lives
			// alongside the conversation rather than replacing `main.conversation` and taking
			// over the entire screen (the owner's complaint: «اللوحات تأخذ الشاشة كاملة»).
			safe("slots:sidebar.right.pane.tab", () => {
				if (!ctx.slots || typeof ctx.slots.inject !== "function") return;
				ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
					name: "sidebar.right.pane.tab", key: "translate-this"
				}, () => h(Panel, { layer, engine, subscribe, embedded: true })));
			});

			safe("slots:sidebar.right.pane.tab.title", () => {
				if (!ctx.slots || typeof ctx.slots.inject !== "function") return;
				ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
					name: "sidebar.right.pane.tab.title", key: "translate-this"
				}, () => h(PanelIcon, { layer, subscribe })));
			});

			safe("slots:sidebar.panellist", () => {
				if (!ctx.slots || typeof ctx.slots.inject !== "function") return;
				ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
					name: "sidebar.panellist", id: "translate-this", order: 60, label: "ترجمة المحتوى"
				}, () => h(PanelIcon, { layer, subscribe })));
			});

			// Header action button: native seat in session header when present in the DOM,
			// with synchronous fallback dock whenever the native seat is missing or undeclared.
			safe("slots:conversation.session.header.actions", () => {
				if (!ctx.slots || typeof ctx.slots.inject !== "function") return;
				ctx.slots.inject("conversation.session.header.actions", () => {
					syncDock();
					return ctx.slots.register({
						name: "conversation.session.header.actions",
						id: "translate-this",
						order: 40
					}, (props) => {
						syncDock();
						return h(HeaderAction, { layer, engine, subscribe });
					});
				});
			});

			syncDock();

			/**
			 * The page chip (the owner's «زرّ بسيط بالأعلى» for interface plugins): while a plugin
			 * PAGE is in the shell's `main` seat there is no conversation in the DOM and no seat of
			 * ours inside that page, so the global button has nothing to aim at. The chip rides the
			 * page's top-right corner and translates THAT page — it never edits the plugin's markup,
			 * so a re-render cannot remove it (measured: logcat re-renders and wipes injected text,
			 * which is why the chip is a control, not a guarantee).
			 */
			let chip = null, chipWatcher = null, chipFrame = 0;
			const placeChip = () => {
				chipFrame = 0;
				if (!chip) return;
				const page = pageRootOf();
				if (!page) { chip.style.display = "none"; return }
				const box = page.getBoundingClientRect();
				if (!box || box.width < 40 || box.height < 40) { chip.style.display = "none"; return }
				const pos = chipPlacement(box, { width: window.innerWidth, height: window.innerHeight });
				if (!pos) { chip.style.display = "none"; return }
				chip.style.display = "";
				chip.style.top = pos.top + "px";
				chip.style.left = pos.left + "px";
				chip.setAttribute("data-busy", layer.busy ? "1" : "");
				chip.setAttribute("aria-label", layer.translatedInElement && page && layer.translatedInElement(page)
					? "استرجاع أصل هذه الصفحة" : "ترجم محتوى هذه الصفحة");
			};
			const scheduleChip = () => { if (!chipFrame) chipFrame = requestAnimationFrame(placeChip); };
			safe("page chip", () => {
				chip = document.createElement("button");
				chip.type = "button";
				chip.className = "dct-chip";
				chip.setAttribute("data-dct-ignore", "");
				chip.title = "ترجم محتوى هذه الصفحة (Translate This)";
				chip.setAttribute("aria-label", chip.title);
				chip.innerHTML = CHIP_SVG;
				chip.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					const page = pageRootOf();
					if (!page) return;
					if (layer.translatedInElement && layer.translatedInElement(page)) layer.restoreElement(page);
					else layer.translateElement(page);
					scheduleChip();
				});
				document.body.appendChild(chip);
				// The page can change without a resize: watch the shell's own seat for children and
				// let the layer's notify cycle drive the rest (no polling timer anywhere).
				const main = document.querySelector('[data-slot="main"]');
				chipWatcher = new MutationObserver(scheduleChip);
				if (main) chipWatcher.observe(main, { childList: true });
				window.addEventListener("resize", scheduleChip);
				window.addEventListener("scroll", scheduleChip, true);
				scheduleChip();
			});

			ctx.effect(() => () => {
				safe("dispose layer", () => layer.dispose());       // which aborts any call still in flight
				safe("dispose dock", () => { if (dockRoot) { try { dockRoot.unmount(); } catch {} dockRoot = null; } if (dock) { dock.remove(); dock = null; } });
				// What is OURS and lives outside the layer is removed here — measured before the
				// fix: the stylesheet stayed (`style[data-dct-style]` 1 → 1), the status request
				// stayed in the air, and the diagnostic handle stayed pointing at a dead layer.
				safe("dispose style", () => { if (styleEl) { styleEl.remove(); styleEl = null; } });
				safe("dispose status request", () => { if (statusAbort) statusAbort.abort(); });
				safe("dispose chip", () => {
					if (chipFrame) { cancelAnimationFrame(chipFrame); chipFrame = 0 }
					if (chipWatcher) { chipWatcher.disconnect(); chipWatcher = null }
					window.removeEventListener("resize", scheduleChip);
					window.removeEventListener("scroll", scheduleChip, true);
					if (chip) { chip.remove(); chip = null }
				});
				safe("dispose debug handle", () => { try { delete window.__dshTranslateThis__ } catch { /* a frozen window is not ours to fight */ } });
			}, "dsh-translate-this: layer + ui");

			// A diagnostic handle: the layer is the product here, and a DOM injector that
			// cannot be inspected from the console is a DOM injector nobody can verify.
			// The per-tab control: the shell renders this seat for EVERY tab of EVERY right-bar
			// panel, whoever wrote it, and hands us the tab it belongs to. That is the general
			// hook the owner asked for — «مثل الزر المحقون في لوحة الاعدادت يعمل مع كل تبويب
			// بسلاسة» — and it is why nothing here needs to know a plugin's name: the shell owns
			// the tab identity, we only resolve it (`tabBodyOf`).
			safe("slots:sidebar.right.tab.menu.item", () => {
				if (!ctx.slots || typeof ctx.slots.inject !== "function") return;
				ctx.slots.inject("sidebar.right.tab.menu.item", () => ctx.slots.register({
					name: "sidebar.right.tab.menu.item", id: "translate-this", order: 40
				}, (props) => h(TabMenuItem, { layer, tab: props && props.tab, dismiss: props && props.dismiss, subscribe })));
			});

			safe("debug handle", () => {
				window.__dshTranslateThis__ = {
					layer, engine, version: "0.8.0",
					/* The registry's own view, so a live measurement can quote what the layer
					   DECIDED (identity, owner, trust, roots) instead of guessing from the DOM. */
					registry: () => Object.values(layer.state).map((s) => ({ id: s.id, label: s.label, owner: s.owner || null, trust: s.trust, on: !!s.on, roots: s.roots || 0, attrTargets: s.attrTargets || 0 })),
					/* The raw seat ledger, so a live measurement can quote what the SHELL says about
					   ownership instead of trusting our reading of it. */
					ledger: () => (layer._internals.slots && layer._internals.slots.snapshot ? layer._internals.slots.snapshot() : null)
				};
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		/* The layer is the product's core and the acceptance page is its harness, so the
		   harness builds the very same layer object the GUI builds — one source, nothing
		   to drift. The UI above is deliberately NOT exported: a harness that drove React
		   would be testing the shell instead of the layer. */
		exports.createLayer = createLayer;
		/* The registry is exported the way the splitter is: the acceptance page drives the very
		   function the plugin uses to decide what a surface IS, so a rule that stops discovering
		   panels fails in CI instead of on somebody else's machine. */
		exports.buildRegistry = buildRegistry;
		exports.MAIN_PAGE_SELECTOR = MAIN_PAGE_SELECTOR;
		exports.stubEngine = stubEngine;
		/* The splitter and the gluer are the unit 0.6 caches on, and `acceptance/protocol.mjs`
		   drives them directly: a splitter that lost a byte would corrupt every translation
		   built on it, and that is cheaper to prove in node than to notice in a GUI. */
		exports.splitSegments = splitSegments;
		exports.composeSegments = composeSegments;
		/* The masking pair is exported for the same reason: `acceptance/golden.mjs` measures how
		   often a real model keeps `<<<K1>>>` intact, and that number is the acceptance criterion
		   «100% سلامة للكود» — it must be measured on the shipping functions, not on copies. */
		exports.maskTokens = maskTokens;
		exports.unmaskTokens = unmaskTokens;
		/* The popover's dismissal rule, exported for the same reason the splitter is: the harness
		   has no React, so a behaviour that lives only inside a hook cannot be driven there. */
		exports.closeOnOutside = closeOnOutside;
		/* The page chip's geometry: pure, so the acceptance page can drive it with synthetic boxes
		   even though it has no React to mount the live widget with. */
		exports.chipPlacement = chipPlacement;
		exports.pageRootOf = pageRootOf;
		return module.exports;
	}
});
