# HOW-TO-TEST — دليل المشرف العمليّ للاختبار في هذا المشروع

> **القاعدة الأمّ**: لا تقل «يعمل» ولا «لا يعمل» — قل **رقمًا** مع **منفذًا** و**بصمة نسخة** و**طريقة إدخال** (نقرة حقيقية؟ نداء طبقة؟). وكل رقم لم تقِسه أنت = **مجهول** لا «صحيح».
> **قبل أن تبدأ**: اقرأ `SUPERVISOR-HANDOFF.md` §⓪‑أ (بيئة المالك) و§٢ (البصمات) و§٤ (البطارية).

---

## ١) الأدوات الثلاث (ومتى تستعمل كلًّا منها)
| الأداة | الاستعمال الصحيح | لا تستعملها لـ |
|---|---|---|
| **`mcp__chrome__evaluate_script`** | قراءة الحالة والقياس: العدّادات، النصوص المرئية، الأبعاد، `localStorage` | **إثبات أن زرًّا يعمل** — فـ`el.click()` **حدث غير موثوق** |
| **`mcp__chrome__click` / `take_snapshot` / `take_screenshot`** | **النقر الحقيقي** (موثوق) وقاعدة الأدلّة البصرية | قياس الأرقام (استعمل `evaluate_script`) |
| **`acceptance/cdp.mjs`** (سكربت من جذر النسخة) | **الأحداث الموثوقة** التي لا تعطيها الأدوات: **السحب** · العجلة · لوحة المفاتيح · فتح تبويب ثانٍ | القياس السريع (أبطأ وأثقل) |

**سجلّ المضيف هو الحكم في الكلفة**: `http://127.0.0.1:<port>/dsh-translate-this/log?limit=1` ⇒ `totals.calls` (ونداءات الطبقة وحدها قد تكذب).
**عدّادات الطبقة** من الصفحة: `window.__dshTranslateThis__.layer.counters` ⇒ `requests · injections · reinjections · attrInjections · segmentsRequested · busy · inflight`.

---

## ٢) الإجراء في عشر خطوات (اتبعه حرفيًّا في كل قياس)
1. **أقلع المضيف** للنسخة المطلوبة والتقط الرابط+التوكن من سجلّ الإقلاع.
2. **افتح تبويبًا واحدًا** لكل نسخة في متصفّح الأدوات (المالك يرى تبويباتك — لا تفتح ما لا يلزم).
3. **اثبت الهوية داخل النتيجة**: `location.port` + بصمة النسخة (`resolveContentTarget`؟ `contentBodyOf`؟ `.dct-chip-back`؟ بطاقة `.dct-dock-bar`؟). **لا تفترض من ترتيب التبويبات — تتحرّك.**
4. **خطّ الأساس**: اقرأ واكتب: عدد العُقد **المرئية** وعربيها · عربي أسماء التبويبات · عدّادات الطبقة · `totals.calls` · عدد `title` (لاتيني/عربي).
5. **نفّذ الإجراء بأكثر إدخال واقعية متاح**: نقرة MCP الحقيقية أولًا، وإن احتجت سحبًا/عجلة ⇒ CDP. **ونداء دالّة الطبقة مباشرةً ليس إثباتًا لسلوك زرّ** (استعمله للتشخيص فقط، وسمِّه «دليل طبقة» لا «دليل زرّ»).
6. **انتظر الاستقرار**: `waitIdle = while(layer.busy || layer.inflight) wait` **ثم** مهلة 1.5–2.5 ثانية، **ثم أعد القراءة** عند +2 و+6 و+12 ثانية ⇒ **المحو المتأخّر عيب** (رآه المالك: الترجمة تختفي بعد إعادة الرسم).
7. **قِس الأثر الذي يراه المستخدم**: النصّ **المرئي** فقط (استثنِ `display:none/visibility:hidden`، وواجهتنا `[data-dct-ignore]`، و`pre/code/input/[contenteditable]`) · أسماء التبويبات · `title`.
8. **قِس الكلفة من المضيف** قبل/بعد: `totals.calls` ⇒ `requestsAdded`. (صفر نداءات = إصابة مذكرة ✓.)
9. **اختبر المسارات السالبة**: بلا هدف · اسم لوحة غير موجود · بطاقة مخفيّة · بطاقة خارج الشاشة ⇒ **مسار صامت = عيب** (يجب رسالة ظاهرة).
10. **نظّف ووثّق**: استرجع الحالة (`layer.restoreAll()` بلا نداءات) · أغلق التبويب · أوقف المضيف الذي شغّلته · واكتب كل الأرقام في كتلة واحدة.

---

## ٣) كتالوج السيناريوهات (البطارية — كل بند بقبوله)
| # | السيناريو | القبول |
|---|---|---|
| ١ | إعدادات: اضغط الترجمة على «عام» | محتوى **≥90%** عربيًّا + **أسماء التبويبات عربية** + `requestsAdded ≥ 1` (أو 0 إن كانت المذكرة ممتلئة) |
| ٢ | **ذهاب وعودة**: «عام» ← «النماذج» ← «عام» | محتواها **ما زال عربيًّا ≥90% بلا ضغط جديد** و`requestsAdded = 0` |
| ٣ | تبديل التبويب **وهو مترجَم** ثم ضغط | نصّ الزرّ **«ترجم»** والضغط **يترجم** (لا يسترجع) |
| ٤ | استرجاع | يعيد **الظاهر وحده** إلى خطّ الأساس بالحرف · `+0` نداءات |
| ٥ | المحادثة: ردّ إنجليزي حقيقي ⇒ ضغط الزرّ الظاهر | `requestsAdded ≥ 1` + عربي يزيد ⇒ ضغطة ثانية **استرجاع حرفي** |
| ٦ | صفحة بلاقن (logcat مدخلان) | العلوي = **نمط جانبي والمحادثة تبقى** · السفلي = **صفحة كاملة** · الشريحة تعمل في الحالتين |
| ٧ | الكاش | «ترجمة ← استرجاع ← ترجمة» = **0** · «إعادة تحميل ← ترجمة» = **0** |
| ٨ | الفوضى | على المحادثة **1** عنصر · على صفحة **≤2** ومجموع عرض الصفّ **≤120px** |
| ٩ | الـtooltips | عنوان إنجليزي معروف يتحوّل عربيًّا + `attrInjections` يزيد + الاسترجاع يعيده |
| ١٠ | البطاقة | **سحب بأحداث CDP** يحرّكها ويُحفظ · طيّ · إخفاء + عودة · **داخل الشاشة بهامش** · العدّادات لا تظهر إلا بطلب |
| ١١ | البوابات | القيم المتوقّعة لكل نسخة (handoff §٣) + **`leak-check` قبل أي التزام** |

---

## ٤) الأخطاء التي أوقعتني (لا تكرّرها)
1. **قياس النسخة الخطأ**: ظننتُ التبويب لموس وهو لميمو ⇒ **البصمة داخل كل نتيجة** (وإلا نُسب عيبٌ إلى بريء).
2. **إثبات الزرّ بنداء الطبقة**: زميل قاس `layer.translateElement(...)` فبدا ناجحًا، والضغطة الحقيقية **لا تفعل شيئًا** ⇒ **الإثبات بالضغطة**.
3. **أحداث غير موثوقة للسحب**: سحب صناعيّ لم يُحرّك البطاقة فقلتُ «لا تُسحب» — والسبب أن التنفيذ يسمع أحداثًا **موثوقة** ⇒ **CDP**.
4. **القياس على مضيف يحتضر**: «نداءات بلا أثر» ظهرت لأن المضيف سقط بعدها ⇒ **أعِد القياس** قبل أن تنشر.
5. **قياس الحاوية الخطأ**: اخترتُ أكبر `div` فظهر «صفر عربي» والترجمة في حاوية أخرى ⇒ **قِس عُقدًا مرئية داخل النافذة** وقارن بواجهة الطبقة (`coverageIn`).
6. **الحكم قبل قراءة مسار الطلب**: قلتُ «لا يوجد كاش» — والكاش **موجود ومعطَّل بشرط ثقة**.
7. **الوثوق بحارس على fixture**: «أخضر في المحاكي، أحمر على السطح الحقيقي» (34 عقدة حقيقية لا 7) ⇒ كل حارس تغطية/وجه يُقاس على **النافذة الحقيقية**.
8. **الالتزام على شجرة متحرّكة**: وكلاء OpenCode يكتبون أثناء قياسك ⇒ **لا تُلتزم إلا ما قِيس على الهاش نفسه** (`git worktree --detach` + junction).
9. **افتراض أن الحالة «مترجَمة» تعني أن الترجمة باقية**: إعادة رسم التطبيق تمحو الحقن ⇒ **قِس بعد الذهاب والعودة**.
10. **إغفال المسار الصامت**: ضغط بلا نتيجة **وبلا رسالة** = عيب دائمًا، حتى لو لم يتغيّر شيء ظاهريًّا.

---

## ٥) قالب مسبار جاهز (انسخه في `evaluate_script`)
```js
async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const port = location.port;                                  // ← الهوية داخل النتيجة
  const api = window.__dshTranslateThis__; const layer = api && api.layer;
  const id = { port, memo: typeof api?.resolveContentTarget === 'function',
               dockBar: !!document.querySelector('.dct-dock-bar'),
               cross: typeof api?.contentBodyOf === 'function',
               back: !!document.querySelector('.dct-chip-back') };
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  const visible = root => { const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), out = []; let n;
    while ((n = w.nextNode())) { const t = norm(n.nodeValue); if (!t) continue;
      if (n.parentElement.closest('[data-dct-ignore]')) continue;
      if (n.parentElement.closest('pre, code, textarea, input, [contenteditable="true"]')) continue;
      const st = getComputedStyle(n.parentElement);
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      const r = n.parentElement.getBoundingClientRect(); if (!r.width || !r.height) continue; out.push(t); }
    return out; };
  const cnt = a => a.length + ' عقدة / ' + a.filter(t => /[\u0600-\u06FF]/.test(t)).length + ' عربية';
  const waitIdle = async (ms = 90000) => { const t0 = Date.now();
    while (Date.now() - t0 < ms && layer && (layer.busy || layer.inflight > 0)) await wait(300); await wait(2000); };
  const host = async () => (await fetch('/dsh-translate-this/log?limit=1').then(r => r.json()).catch(() => ({}))).totals || {};
  const dlg = () => document.querySelector('[role="dialog"]');
  const pane = () => { const d = dlg(); if (!d) return null; const nav = d.querySelector('nav');
    return Array.from(d.querySelectorAll('div,section'))
      .filter(el => !el.contains(nav) && norm(el.textContent).length > 200)
      .sort((a,b) => norm(b.textContent).length - norm(a.textContent).length)[0] || d; };
  const snap = async tag => ({ tag, id: id.port, pane: cnt(visible(pane())),
    navAr: (norm(dlg()?.querySelector('nav')?.textContent).match(/[\u0600-\u06FF]/g) || []).length,
    req: layer.counters.requests, host: (await host()).calls });
  const out = { id, steps: [] };
  out.steps.push(await snap('baseline'));
  // ← ضع هنا نقرة MCP حقيقية في نداء منفصل، ثم عُد وقِس:
  return JSON.stringify(out, null, 1);
}
```
**ملاحظة**: النقر الحقيقي يجري في **نداء أداة منفصل** (`mcp__chrome__click` على `uid` من `take_snapshot`) — فالمسبار يقيس ولا ينقر إن أردت دليلًا موثوقًا.

---

## ٦) صيغة الحكم (اكتبها في `VERDICT-*.md`)
```
## ما قِيس (منفذ ↔ نسخة ↔ هاش)
| الفحص | الأداة | قبل | بعد | الحكم |
## ما ثبت ✓   ## ما فشل ✗ (كلٌّ برقم)
## الإصلاح المطلوب (محدّد)   ## الحارس المطلوب + إثبات الإزالة
## ما لم أقِسه (بصراحة)
```
ثم: **التزم الملفّات التي تحقّقتَ منها فقط** (لا ملفّات المالك) · انسخ الوثيقة للنسخ الأربع · `git push`.
