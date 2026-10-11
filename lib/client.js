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
			for (let i = 0; i < tokens.length; i += 1) {
				const marker = "<<<K" + (i + 1) + ">>>";
				if (!out.includes(marker)) { missing.push(i + 1); continue; }
				out = out.split(marker).join(tokens[i]);
			}
			const leaked = /<<</.test(out);
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
					if (host) { host.setAttribute(MARK, "1"); host.setAttribute("dir", "rtl"); host.style.unicodeBidi = "isolate"; }
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
					L.debug = "فشل المحرّك: " + String((error && error.message) || error);
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
				translateElement, restoreElement, translatedInElement, syncRegistry,
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
/* The same panel, two seats: the header popover (fixed) and the shell's main area (0.8).
   Embedded it fills the pane instead of floating over the conversation, because the 0.8
   acceptance test reads it WHILE a live stream runs — a readout you must close to see the
   stream is not a readout. */
.dct-panel.dct-embedded { position: static; inset: auto; width: auto; max-height: none;
  box-shadow: none; border: 0; border-radius: 0; background: transparent; }
.dct-glyph { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; }
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
			// THIS surface's state, not the layer's: the conversation being translated must not
			// make the settings button read «استرجاع الأصل» on a settings page that was never
			// translated (the owner's report), and a hidden tab's leftovers must not either.
			const translated = props.layer.translatedIn("settings");
			useEffect(() => {
				// The header icon declares the page as well as translating it: the labelled row
				// lives in the General tab, and a surface must not depend on which tab is open.
				props.layer.markSurface(pageAncestor(ref.current ? ref.current.parentElement : null, "settings"), "settings");
			}, []);
			const act = () => {
				if (props.layer.translatedIn("settings")) props.layer.restoreSurface("settings");
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
			const translated = props.layer.translatedIn("settings");     // this surface only — see SettingsIcon
			useEffect(() => {
				props.layer.markSurface(pageAncestor(ref.current ? ref.current.parentElement : null, "settings"), "settings");
			}, []);
			return h("div", { className: "dct-settings-row", "data-dct-ignore": "", ref },
				h("span", { className: "dct-settings-label" }, busy ? "جارٍ ترجمة الإعدادات…" : (translated ? "استرجاع نصّ الإعدادات" : "ترجمة محتوى الإعدادات")),
				button(busy ? h(Spinner) : translateIcon(), () => {
					if (props.layer.translatedIn("settings")) props.layer.restoreSurface("settings");
					else props.layer.setSurface("settings", true);
				}, {
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
			// The registry can hold dozens of identities (every seat the shell renders), so the panel
			// leads with the ones that HAVE a root right now, counts the rest instead of hiding them,
			// and always reports the totals — a list that silently drops zeros is a list that lies.
			const all = Object.values(layer.state);
			const rows = all.filter((s) => (s.roots || 0) > 0)
				.sort((a, b) => (Number(b.on) - Number(a.on)) || ((b.roots || 0) - (a.roots || 0)))
				.concat(all.filter((s) => !(s.roots || 0)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, 24));
			const quiet = all.length - rows.length;
			const enabled = all.filter((s) => s.on).length;
			const totalRoots = all.reduce((a, s) => a + (s.roots || 0), 0);
			const queued = layer._internals ? layer._internals.queue.length : 0;
			return h("div", { className: "dct-panel" + (props.embedded ? " dct-embedded" : ""), "data-dct-ignore": "", dir: "rtl", lang: "ar" },
				h("div", { className: "dct-title" }, "ترجمة المحتوى — Translate This"),
				h("div", { className: "dct-note" }, props.engine.label),
				h("div", { className: "dct-row" },
					h("span", null, "لغة الترجمة"),
					h("select", {
						className: "dct-select", value: layer.target, "data-dct-ignore": "",
						onChange: (e) => layer.setTarget(e.target.value)
					}, TARGETS.map((t) => h("option", { key: t.code, value: t.code }, t.label)))
				),
				// The progress line: every number here is a live reading from the layer, never a
				// timer. It also names the attributes queue, because a panel whose titles are
				// still in flight is working even when no text node is.
				busy ? h("div", { className: "dct-note dct-warn" },
					h("span", { className: "dct-spin", style: { marginInlineEnd: 6 } }),
					"جارٍ الترجمة… طلبات جارية " + layer.progress.inflight + " · في الطابور " + layer.progress.queued +
					(layer.progress.attrsQueued ? " · سمات في الطابور " + layer.progress.attrsQueued : "") +
					(layer.progress.segmentsPending ? " · مقاطع تنتظر دفعة " + layer.progress.segmentsPending : "")) : null,
				layer.loopFlag ? h("div", { className: "dct-bad" }, "حلقة مشتبهة: أُوقفت الطبقة (أكثر من 300 حقن في ثانية).") : null,
				layer.debug ? h("div", { className: "dct-bad" }, layer.debug) : null,
				h("div", { className: "dct-sec" },
					h("div", { className: "dct-kv" }, h("span", null, "سجلّ الأسطح (يُولَّد من مقاعد الشل)"),
						h("b", null, all.length + " سطحًا · " + enabled + " مُفعَّلًا · " + totalRoots + " مستهدفًا")),
					totalRoots === 0 ? h("div", { className: "dct-note dct-warn" },
						"لا سطح واحد مطابق الآن: هذا قياس، لا عطل صامت — أبلغ به كما هو.") : null,
					quiet > 0 ? h("div", { className: "dct-note" },
						"و" + quiet + " سطحًا آخر بلا جذر في هذه اللحظة (عدد مقيس، لا أسماء مخفيّة).") : null,
					...rows.map((s) => h("div", { className: "dct-row", key: s.id },
						h("label", { title: s.id + (s.owner ? " · " + s.owner : "") }, h("input", {
							type: "checkbox", checked: !!s.on, "data-dct-ignore": "",
							onChange: (e) => layer.setSurface(s.id, e.target.checked)
						}), " " + s.label + (s.owner ? h("span", { className: "dct-note" }, " · " + String(s.owner).replace(/^@/, "").slice(0, 28)) : null)),
						h("span", { style: { display: "inline-flex", gap: 6, alignItems: "center" } },
							// `+N سمات`: the attributes path is a measurement too, so a surface whose
							// rows have titles says how many of them the last pass queued.
							h("b", null, (s.roots || 0) + (s.attrTargets ? " + " + s.attrTargets + " سمات" : "") + " · " + tierLabel(s) +
								(s.kind === "handed" ? " · مقعد" : "") +
								(s.trust === "untrusted" ? " · بلا كاش" : (s.trust === "chrome" ? " · هيكل" : ""))),
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
					// 0.8: the bounded attributes path, counted on its own. A merged number would
					// make "how much of that panel is Arabic?" unanswerable.
					h("div", { className: "dct-kv" }, h("span", null, "سمات مُترجمة (title/aria-label)"), h("b", null,
						c.attrInjections + (c.attrRestores ? " · أُعيد " + c.attrRestores : "") + (c.attrDropped ? " · مُهمَلة " + c.attrDropped : ""))),
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
			// NO surface table: the surfaces come from the runtime registry, whose sources are the
			// shell's seat ledger (`ctx.slots`) and the app's own markers. That is the whole point
			// of 0.8 — a table written here could only ever cover plugins that already existed.
			layer = createLayer({ engine, slots: ctx.slots, onChange: () => { for (const fn of listeners) { try { fn(); } catch { /* noop */ } } } });

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

			// The progress panel as a REAL panel (0.8): the shell's `main` seat plus a row in
			// `sidebar.panellist`, the same pair a panel plugin uses. Why a panel and not just
			// the popover: the 0.8 acceptance test runs with a live stream attached, and a progress
			// readout that closes the moment you look elsewhere is not a readout. `main` is a KEYED
			// seat (`{ name, key }`), and the key is ours.
			let panelSeat = false;
			safe("slots:main", () => {
				if (!ctx.slots || typeof ctx.slots.inject !== "function") return;
				ctx.slots.inject("main", () => {
					panelSeat = true;
					return ctx.slots.register({ name: "main", key: "translate-this" },
						() => h(Panel, { layer, engine, subscribe, embedded: true }));
				});
			});

			safe("slots:sidebar.panellist", () => {
				if (!ctx.slots || typeof ctx.slots.inject !== "function") return;
				ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
					name: "sidebar.panellist", id: "translate-this", order: 60, label: "ترجمة المحتوى"
				}, () => h(PanelIcon, { layer, subscribe })));
			});

			// If the shell offers neither seat, the header button + popover is still the whole
			// product — but the absence is SAID, not swallowed (this project's oldest rule).
			if (!panelSeat) layer.note("لوحة التقدّم: المضيف لا يوفّر فتحة main — اللوحة متاحة من زرّ الرأس فقط");

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
		return module.exports;
	}
});
