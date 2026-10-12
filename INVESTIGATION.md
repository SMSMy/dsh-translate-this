# INVESTIGATION — «اللوحات تأخذ الشاشة» و«الزرّ لا يترجم»: مصادر وقياسات وبريف تحقيق

> ملف تسليم للتحقيق (محلي؛ لا يُنشر). كل رقم هنا **مقيس** على جهاز المالك في 2026-10-12، وأوامر إعادة القياس مذكورة في §6.
> الغرض: أن يستطيع أي محقّق (إنسانًا كان أو نموذجًا) أن يعيد كل قياس بنفسه، وأن يعرف أيّ عطبٍ **عندنا** وأيّها **عند الشل**.

---

## §1 المصادر الرسمية (روابط)

| المصدر | الرابط | لماذا يهمّنا |
|---|---|---|
| المستودع الرسمي | <https://github.com/deepseek-ai/deepseek-harness> | كل حزم النواة، ومنها حزم العميل |
| توثيق المطوّرين | <https://deepseek-harness.github.io/deepseek-harness/en/guide/quickstart> | البدء، أوامر CLI، هيكل البلاقن |
| **عقد مقاعد العميل** | <https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/AGENTS.md> | يوثّق `slots.inject(name, () => ctx.slots.register(...))` ومتى تُنتظر إعلانات المقاعد |
| بلاقنات المجتمع | <https://github.com/topics/dsh-plugin> | أمثلة جاهزة لأنماط اللوحات والأزرار |
| ورقة Cordis (الإطار) | <https://arxiv.org/abs/2608.25512> | نموذج الـfiber/الخدمات/الحقن الذي تفسّره `inject` |
| سوق DSH ومفهرسه | `GET http://127.0.0.1:19387/dsh-market/registry` (محلي) | قائمة الحزم المقبولة للتثبيت في الديسكتوب |

## §2 المصادر المحلية (الأصدق لهذه النسخة المثبَّتة)

**حزم النواة (تُقرأ كملفات عادية):**
`%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`

| الحزمة | ما تملكه |
|---|---|
| `dsh-client-ui-slots` | خدمة المقاعد في العميل (`inject` / `register`) — الملف المرجع لعقد المقاعد |
| `dsh-cordis-client-runner` | مُشغّل وحدات العميل: `window.__ModuleLoader__.load({id, factory})` |
| `dsh-client-ui-conversation` | مقعد `conversation.session.header.actions` (رأس الجلسة) |
| `dsh-client-ui-sidebar` | `sidebar.panellist` (قائمة اللوحات في الشريط الأيسر) |
| `dsh-client-ui-sidebar-right` | الشريط الأيمن + `sidebar.right.pane.tab.title` + `sidebar.right.tab.menu.item` |
| `dsh-client-ui-sidebar-files` · `-terminal` · `-documentpreview` · `dsh-client-ui-open-in-app` | **أمثلة حيّة** لتبويب يعيش في الشريط الأيمن (المقعد الذي يريده المالك للوحات) |
| `dsh-client-ui-layout` | مقعد `main` (منطقة الصفحة) |

**واجهة التطبيق (Electron):** `C:\Users\hshli\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`
— ليست مجلدًا في نظام الملفات؛ تُستخرَج بـ`npx @electron/asar extract app.asar out`، وهي **مصدر الحقيقة لنسخة التطبيق** (قد تختلف عن نسخة الـCLI التي تُختبر بها البوابات!).

**أمثلة من المجتمع على جهازنا:**
`@windypro-rourou/dsh-logcat` (صفحة في `main`) · `dsh-mnemon` · `@linxin666/dsh-client-ui-task-board` · `dsh-arabic` — كلها في `~/.dsh/profiles/desktop/node_modules/`.

## §3 كتالوج المقاعد (مقيس بالبحث في الحزم أعلاه)

| المقعد | من يُعلنه | ما يُسجَّل فيه | مثال رسمي |
|---|---|---|---|
| `main` | `dsh-client-ui-layout` | `{ name: "main", key: "<مفتاحك>" }` → صفحة كاملة | `dsh-logcat` · `dsh-mnemon` |
| `sidebar.panellist` | `dsh-client-ui-sidebar` | `{ name, id, order, label }` → صفّ في قائمة اللوحات | `dsh-logcat` |
| `conversation.session.header.actions` | `dsh-client-ui-conversation` | `{ name, id, order }` → زرّ في رأس الجلسة | `dsh-client-ui-jobs` · `-subagent` |
| `sidebar.right.pane.tab.title` | `dsh-client-ui-sidebar-right` | عنوان تبويب في الشريط الأيمن | `dsh-client-ui-sidebar-files` |
| `sidebar.right.tab.menu.item` | `dsh-client-ui-sidebar-right` | بند في قائمة تبويب الشريط الأيمن | (موجود؛ بلا مثال رسمي مُسجِّل) |
| `settings.action` · `settings.general.item` | `dsh-client-ui-settings-general` | زرّ/صفّ في نافذة الإعدادات | `dsh-client-ui-theme` |
| `shell.overlay` | `dsh-client-ui-layout` | غطاء فوق الشل | — |

**قاعدة مقيسة**: `ctx.slots.inject(name, cb)` **ينتظر إعلان المقعد**؛ فإن لم يُعلَن قطّ لا يُنادى `cb` ولا يظهر شيء — بلا خطأ ولا تحذير. لذلك أي مساهمة تحتاج **بديلًا** إن لم يُعلَن المقعد.

## §4 القياسات على واجهة المالك (2026-10-12)

**الطريقة**: دخول إلى وكيل `dsh-pocket` على المنفذ 3081 بـPIN الشبكة المحلية (`~/.dsh/dsh-pocket/token-lan`)، ثم حقن الكوكي في Chrome عبر CDP، ثم تقييم سكربت للقراءة فقط. الأمر: `node .tmp/lead/see-owner-gui2.mjs --expr .tmp/lead/diagnose-owner2.js` (لا يطبع أي سرّ).

**النتائج الحاسمة (نسخ حرفية):**

| القياس | القيمة |
|---|---|
| `pluginHandle` | `true` · `version "0.8.0"` ⇒ نصف العميل يعمل |
| `anyDctInPage` | `styles: 1 · chips: 1 · panels: 0 · buttons: 0 · marks: 0` |
| `seats.headerActions.present` | **`false`** (لا عنصر `[data-slot="conversation.session.header.actions"]` في الصفحة أصلًا) |
| `seats.panellist` | `present: true` · `children: 1` · `dctStamped: 0` |
| `layer.diagnostics` | `["لوحة التقدّم: المضيف لا يوفّر فتحة main — اللوحة متاحة من زرّ الرأس فقط"]` |
| `console errors` | `none` |
| `main` | `[{ slot: "main.conversation", len: 130, hasConversation: true }]` ⇒ **المحادثة وحدها، ولا لوحة** |
| الشريط الأيمن | 4 أزرار شل فقط: «علامة تبويب جديدة · تقسيم · الخروج من ملء الشاشة · طيّ الشريط الجانبي الأيمن» — **بلا أي تبويب بلاقن** |
| `slots` service keys | `_core · _stores · _rootContributions · _rootListeners · _rootBinding · _rootSource · _scopes · _scopeRevision …` |

## §5 التشخيص

### ٥-١ عطب عندنا — **مُصلَح** (`lib/client.js`)
`native` كان يُرفع **بمجرد نداء** `ctx.slots.inject(...)` لا عند **إعلان المقعد**؛ فحين لم يُعلَن المقعد في تطبيق المالك سقط البديل DOMّي (الرصيف) وبقيت الصفحة **بلا أي زرّ** (`buttons: 0`). الإصلاح: يُرفع العلم داخل دالة الإقلاع، ويُنزع الرصيف لو أُعلن المقعد لاحقًا (كي لا يظهر زرّان).

### ٥-٢ لغز يحتاج تحقيقًا — لماذا لا تُعلَن المقاعد في التطبيق؟
نفس الكود يُنتج مساهمات ظاهرة في مضيف CLI (`dct08`: `.dct-panel` مُركَّب، واللوحة تُرسم)، ولا يُنتج شيئًا في تطبيق المالك. الفروق المرشّحة للفحص:
1. **نسخة العميل**: قارن `dsh-client-ui-slots` و`dsh-cordis-client-runner` بين `app.asar` (٢٠٢٦-٠٩-٢٩) ونسخة CLI (`0.2.1-alpha.2`). مفاتيح `_rootContributions`/`_scopes` توحي بعقود **مقيَّدة بجذر (root/scope)**.
2. **تعدّد الجذور/مساحات العمل** في تطبيق المالك قد يعني أن المساهمة تُسجَّل في جذر غير المعروض.
3. **ترتيب الإقلاع**: هل تُعلَن المقاعد **قبل** `apply` أم بعده؟ (عندنا: بعد — ولذلك صار البديل ضروريًا).

### ٥-٣ «اللوحات تأخذ الشاشة كاملة» — ليست منّا
`dsh-logcat` و`dsh-mnemon` تسجّلان أنفسهما **صفحةً في `main`** بنصّ كودهما:
```js
ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: "logcat" }, makePanel))
ctx.slots.inject("sidebar.panellist", () => ctx.slots.register(...))
```
وشلّنا يعرض **صفحة واحدة في `main`** في كل مرة ⇒ فتح لوحةٍ يستبدل المحادثة (وتُفكّ من الشجرة: مقيس `conversationInDom: false` عند فتح logcat). والحلّ ليس عندنا: إمّا أن تُسجّل تلك الإضافات تبويبًا في `sidebar.right.pane.tab.title` (كما تفعل `-files` و`-terminal`)، أو نعرض ترجمتها في **لوحة خاصة بنا** (اقتراح «اللقطة المجمّدة» في §7).

## §6 كيف يعيد المحقّق القياس

```powershell
# ١) واجهة المالك للقراءة فقط (لا ينقر ولا يترجم ولا يطبع أسرارًا)
node .tmp\lead\see-owner-gui2.mjs --expr .tmp\lead\diagnose-owner2.js

# ٢) بوابات المشروع (على نسخة CLI، لا على التطبيق!)
node acceptance\protocol.mjs ; node acceptance\host.mjs ; node acceptance\run.mjs --port 19696

# ٣) أي مضيف CLI ببروفايل اختبار (فيه بلاقننا + لوحات طرف ثالث)
node %APPDATA%\npm\node_modules\@deepseek-ai\dsh\lib\bin.js dct08 --port 3110 --no-open
```
ومن داخل التطبيق نفسه (DevTools): `JSON.stringify(window.__dshTranslateThis__.layer.diagnostics)` ثم `document.querySelectorAll('.dct-btn').length` ثم `!!document.querySelector('[data-slot="conversation.session.header.actions"]')`.

## §7 ما أُصلح وما بقي

| البند | الحال |
|---|---|
| زرّ مفقود تمامًا لأن البديل يُتجاوَز | **مُصلَح** (علم `native` يُرفع عند الإعلان + نزع الرصيف عند الإعلان المتأخّر) |
| سبب عدم إعلان المقاعد في التطبيق | **مفتوح** — §5-2 (يحتاج مقارنة `app.asar` بنسخة CLI) |
| اللوحات تأخذ `main` | **سلوك الإضافات نفسها** — §5-3؛ الحلّ عندها أو بلوحة لقطة عندنا |
| الشريحة (`.dct-chip`) | موجودة ومخفيّة فوق المحادثة؛ تظهر فوق أي صفحة إضافات وتُترجمها |
| مقعد `sidebar.right.tab.menu.item` | موجود في الشل؛ لم يُرَ تسجيلنا فيه حيًّا ⇒ يحتاج مقارنة بعد إصلاح §5-2 |
