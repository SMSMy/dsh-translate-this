# CLEAN-PUSH-RUNBOOK — حذف التاريخ وإعادة رفع نظيفة

> الخطة: **بعد استقرار العمل** ⇒ احذف مستودع GitHub بالكامل ⇒ أنشئ مستودعًا فارغًا جديدًا ⇒ ارفع **التزامًا واحدًا** من شجرة نظيفة.
> هذا هو **السبيل الوحيد الكامل**: `push --force` يترك الالتزامات القديمة قابلةً للوصول بالهاش عبر واجهة GitHub وذاكرتها المؤقتة، أما **حذف المستودع** فيُزيلها فعلًا.

---

## ١) ما الذي أفسد التاريخ (تشخيص مقيس — 2026-10-12)
| # | الملوِّث | الدليل |
|---|---|---|
| ١ | **التزام آليّ من بلاقن checkpoint** أدخل **نسخة كاملة من المشروع داخل المشروع**: `63d6123 Turn Rewind checkpoint rp_mv5khc1s_d3ed191d71b0` — أضاف `worktree/**` بمئات الملفّات، ومنها **ملفّ المالك الخاصّ** `worktree/plan-to-fix is dune.md` و`code.html` وكل `FINDING-*`/`HANDOFF`/`HOW-TO-TEST` مرّتين | `git log --name-status -- 'worktree/*'` · الهوية `Turn Rewind <turn-rewind@localhost>` |
| ٢ | **ملفّات ضخمة من عصر سابق** (`vendor/ort/*.wasm`): **25.5 + 23 + 14.2 + 12.6 م.ب** ≈ 75 م.ب غير مضغوطة، لا يحتاجها البلاقن الحالي (لا ONNX في `PLAN`) | `git rev-list --objects --all` + `cat-file -s` |
| ٣ | **خلط هويّات الالتزام**: المالك `yazid <94212436+SMSMy@…>` · بلاقن `Turn Rewind <turn-rewind@localhost>` · مؤلّف المشروع الأصلي `Nysj N <…@user.noreply.gitee.com>` · `dsh-auto-translate <dev@localhost>` | `git log --format='%an <%ae>' \| group` |
| ٤ | **فروع محليّة قديمة** (`fix/locale-neutral-hint-assertions` · `hermes/deepseek` · `v0.5-basis`) + **remote ثانٍ `upstream`** (المستودع الأصلي ⇒ هذا fork) | `git branch` · `git branch -r` |

**الإجمالي**: **72 التزامًا** · **305 ملفًّا** دخلت التاريخ · حجم الحزمة **16.18 MiB**.

> ✅ **والشجرة الحالية نظيفة**: `git ls-files` لا يحوي أيّ ملفّ من ملفّات المالك ولا `worktree/`.
> ⚠️ **لكن `.gitignore` لا يمنع `worktree/`** ولا ملفّات المالك (تغطّي `HANDOFF.md` · `audit.md` · `plan-to-fix.md` بلا مسافة · `.tmp/` · `node_modules/` · `*.log` · `acceptance/shots/` · `tools/gui-probe.json`) ⇒ **يجب توسيعه** (البند ٤).

---

## ٢) قبل الحذف: احتفظ بنسخة أمنية
```powershell
cd C:\Code-backup\dsh-translate-this
git bundle create ..\dsh-translate-this-FULL-HISTORY-$(Get-Date -f yyyyMMdd-HHmm).bundle --all
# نسخة كاملة من التاريخ القديم (≈16MB) تُفتح لاحقًا بـ: git clone <file>.bundle
```

---

## ٣) ما يُشحن في المستودع النظيف (قائمة الانتقاء)
### أ) **إلزامي** (يشغّل البلاقن ويُقاس)
`lib/` (المضيف + العميل) · `data/` · `acceptance/` (بلا `shots/`) · `tools/` (**وفيها `leak-check.mjs` بوابة**) · `package.json` · `cordis.patch.yml` · `.gitignore`
### ب) **مُستحسن**
`README.md` (عربي) · `README.en.md` · `LICENSE` · `NOTICE.md` · `PLAN.md` · `REBUILD.md`
### ج) **قرار المالك** (معرفة مشروع/عملية)
`FINDING-*.md` · `VERDICT-*.md` · `HOW-TO-TEST.md` · `SUPERVISOR-HANDOFF.md` · `COMPETITION.md` · `PANEL-BRIEF.md` · `INVESTIGATION.md` · `REVIEW-*.md` · `TASK-*.md`
> التوصية: **أ** و**ب** تُشحن دائمًا، و**ج** تُترك محليّة **إلا** ما هو معرفة تقنية مفيدة للقارئ (`FINDING-plugin-page-column-v3` · `FINDING-translation-cache` · `HOW-TO-TEST`) — والباقي عملية داخلية.
### د) **ممنوع تمامًا**
`تحقيق السيد جيم.md` · `تحقيق السيد كلاو.md` · `plan-to-fix is dune.md` · `worktree/**` · `vendor/**` · `.tmp/**` · `node_modules/**` · `*.log` · `acceptance/shots/**` · `tools/gui-probe.json` · أي `.tgz`/`.zip`/`.env`/اعتماد · `agent-kit/**`
> و**`code.html`** (ملفّ المالك، 24.7 KB) **متتبَّع الآن** — قرّر: يُشحن كتصميم مرجعي أم يُستبعد؟ (الافتراضي: يُستبعد لأنه ملفّ المالك).

---

## ٤) `.gitignore` النظيف (استبدله بالكامل)
```gitignore
node_modules/
.cache/
.tmp/
*.log

# نسخ عمل مؤقّتة (بلاقن checkpoint أدخل واحدة في التاريخ سابقًا)
worktree/
/worktree/

# ملفّات المالك — لا تُشحن ولا تُلتزم
تحقيق*.md
plan-to-fix*.md
code.html

# أدلّة القياس المحلّية
acceptance/shots/
tools/gui-probe.json
HANDOFF.md
audit.md
*.tgz
*.zip
.env
.DS_Store
Thumbs.db
```

---

## ٥) الخطوات الحرفية (نفّذها بهذا الترتيب)
```powershell
# ٠) جمّد كل كاتب: أوقف محادثات OpenCode للوكلاء (وإلا تغيّرت الشجرة أثناء النسخ)
# ١) اختر الشجرة النهائية (النسخة التي ستُشحن) — لا تخلط نسختين
$src = 'C:\Code-backup\dsh-translate-this'      # أو مجلد النسخة الفائزة
$dst = 'C:\Code-backup\dsh-translate-this-clean'

# ٢) انسخ الانتقاء فقط (لا git clone — يجلب التاريخ)
New-Item -ItemType Directory $dst | Out-Null
foreach ($p in @('lib','data','acceptance','tools','package.json','cordis.patch.yml','README.md','README.en.md','LICENSE','NOTICE.md','PLAN.md','REBUILD.md')) {
  Copy-Item (Join-Path $src $p) $dst -Recurse -Force
}
Remove-Item "$dst\acceptance\shots" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$dst\tools\gui-probe.json" -Force -ErrorAction SilentlyContinue
# (أضف ملفّات المجموعة «ج» التي يريد المالك شحنها)

# ٣) اكتب .gitignore النظيف (البند ٤) ثم:
cd $dst
git init -b main
git config user.name  'yazid'
git config user.email '94212436+SMSMy@users.noreply.github.com'
git add .                      # ← هنا فقط يُسمح بـ add . لأن الشجرة انتقائية ونظيفة
git commit -m "dsh-translate-this 0.8.x — the plugin as shipped"

# ٤) فحوص ما قبل الدفع (إلزامية)
node tools\leak-check.mjs                                  # LEAK-CHECK CLEAN · exit 0
git ls-files | Select-String 'تحقيق|plan-to-fix|worktree/|vendor/|node_modules|\.tmp/|\.log$|\.tgz$'   # يجب أن يكون فارغًا
git log --oneline                                          # التزام واحد فقط
git count-objects -vH | Select-String 'size-pack'          # صغير (بلا vendor)
npm pack --dry-run                                         # تحقّق من محتوى الحزمة

# ٥) على GitHub: Settings → Danger Zone → Delete this repository  (يمحو التاريخ بالكامل)
# ٦) أنشئ مستودعًا جديدًا فارغًا (بلا README ولا .gitignore ولا License)
git remote add origin https://github.com/SMSMy/dsh-translate-this.git
git push -u origin main                                    # بلا --force

# ٧) نظّف المحلي: أزل الفروع القديمة والـremote الثاني
git branch -D fix/locale-neutral-hint-assertions 'hermes/deepseek' v0.5-basis
git remote remove upstream        # إن لم تكن تنوي المساهمة في المشروع الأصلي

# ٨) تحقّق بعد الدفع
cd $env:TEMP; git clone https://github.com/SMSMy/dsh-translate-this.git verify-clean
cd verify-clean; node acceptance\protocol.mjs              # 12/12 بلا تثبيت اعتمادات
git log --oneline | Measure-Object -Line                   # 1
```

---

## ٦) سياسة الالتزام بعد النظافة (لمنع تكرار الفساد)
1. **لا `git add -A` ولا `git add .` أبدًا** بعد الرفع — أضف **بالمسار المحدّد** (`git add lib/client.js acceptance/index.html`).
2. **المشرف وحده يلتزم**؛ الوكلاء لا يلتزمون، ولا يدفعون.
3. **أوقف الالتزام الآليّ** لبلاقن الـcheckpoint في هذا المستودع (هو من أنشأ `63d6123`): عطّل الـcheckpoint فيه، أو تأكّد أنّه لا يُشغّل `git add -A` — **وإلا عاد `worktree/`**.
4. **`node tools/leak-check.mjs` قبل كل دفع** (بوابة، لا نصيحة) + `git status --short` لمراجعة ما ستضيفه.
5. **هويّة واحدة** للالتزامات (`yazid <94212436+SMSMy@users.noreply.github.com>`) — لا هويّات بلاقنات ولا `dev@localhost`.
6. **لا أسرار** في المستودع: التوكنات والـPIN ومخزن الاعتمادات في `~/.dsh` فقط.
7. **النسخ الأربع للمنافسين تبقى محليّة** — لا تُدفع إلى أي remote.
8. **لا tag ولا `npm publish`** بلا إذن صريح.

---

## ٧) ما لا يُصلحه هذا الدليل (تنبيه)
- أي **fork** أو **نسخة مستنسخة** من المستودع القديم تبقى عند من أخذها (GitHub لا يستطيع سحبها) ⇒ لكن **لا أسرار** دخلت أيّ التزام (مُتحقَّق سابقًا: مفتاح التوقيع لم يدخل التاريخ أبدًا ✓).
- `upstream` (المشروع الأصلي) لا يتأثّر بشيء — فهو مصدر مستقلّ.
- إن أردت الاحتفاظ بالتاريخ للرجوع: **الـbundle** في البند ٢ يكفي، وهو محليّ لا يُشحن.
