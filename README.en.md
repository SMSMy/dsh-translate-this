# dsh-translate-this

**On-demand translation of DeepSeek Harness interface content — with your own model.**

Press *Translate this content* and each block is swapped in place as soon as it is ready: answer text, tool output, file previews, and plugin panels (Logcat and friends). No external translation service, no extra API key, and no auto-translating a page you did not ask for.

> **Status: early — before any plugin code.** The first artifact is the **standalone acceptance page** (`acceptance/index.html`): it imports neither DSH nor any plugin, runs on a fixed engine, and proves four outcomes in a real browser before a single line of injection code is written. The full plan is in [PLAN.md](PLAN.md).

## What it will do

- **On demand, never automatic**: one button in the session header; each block is injected the moment it is translated.
- **On the user's own model**: through DSH's model service (`ctx.llm`) — no ONNX, no weight downloads, no anonymous third-party service.
- **With the cost on screen**: every block carries its model, a token counter is visible, and batching plus caching keep the bill down.
- **With real terminology**: a versioned prompt and a glossary derived from `dsh-arabic` — professional translation, not literal.
- **Four surfaces**: answers · tool output · file previews · plugin panels. **Reasoning is excluded** (an official plugin owns it).

## What it will not do

- No reasoning translation · no UI-language pack (that is `dsh-arabic`'s ground) · no code or terminal translation · no text sent to a third party · no page translated behind your back.

## Not to be confused with

| Repository | What it is |
|---|---|
| `gst20060726/dsh-auto-translate` | A community plugin that translates **on hover** with an on-device model — different engine, trigger and code |
| `PerryLink/dsh-translate` | **Not text translation**: it maps **vendor parameters** (`temperature`/`top_p`/…) and repairs JSON |
| `dsh-arabic` | The Arabic UI language pack and direction layer — this project complements it |

## License and attribution

MIT — see [NOTICE.md](NOTICE.md).
