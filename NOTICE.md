# NOTICE — origin, attribution, and what is *not* reused

## Origin of the idea

This project exists because a community plugin, [`gst20060726/dsh-auto-translate`](https://github.com/gst20060726/dsh-auto-translate)
(MIT), takes a different trade-off — hover-triggered, on-device WASM models, Chinese-first — and its
maintainer has not been reachable since 2026-10-01 while two pull requests and a feature request sit
unreviewed. Two of those pull requests are useful on their own and are credited here:

- `test: pin the hint locale so the contract suite is host-independent` — the suite only passed on a
  Chinese host because the assertion followed `navigator.language`.
- `feat: give RTL targets a direction, and take it back on restore` — the swapped-in text kept the
  shell's LTR base direction, so Arabic read with the wrong ordering.

Both remain open upstream. This repository does **not** carry the upstream history: our architecture
is written from scratch, and the upstream tree ships vendored `transformers.js` bundles that GitHub's
push protection flags as secret-like content (a false positive in the vendor code, but a reason not to
mirror the history).

## What may be reused, and how it is credited

- **The sentence splitter** (`splitSentences` + `chunkText` in the upstream `client.js`), if it is
  reused, is copied as a small function **with this notice** and its upstream comment kept — it guards
  decimal points and abbreviations so a sentence is not cut in half.
- **The RTL direction behaviour** is reimplemented here; the upstream pull request above is credited in
  the commit that lands it.

Nothing else is copied. No vendored bundles, no `localStorage` cache from the upstream plugin, and no
dependency on any `@deepseek-ai/*` package.

## Not affiliated

- [`PerryLink/dsh-translate`](https://github.com/PerryLink/dsh-translate) is an unrelated plugin
  (vendor **parameter** translation and JSON repair). The similar name is a coincidence of vocabulary.
- This repository is the only official source of the `dsh-translate-this` package. Same-named copies
  elsewhere are not affiliated.

## License

MIT (see [LICENSE](LICENSE)). The upstream plugin is MIT as well; the parts credited above keep that
license.
