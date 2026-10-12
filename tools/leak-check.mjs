#!/usr/bin/env node
/**
 * tools/leak-check.mjs — يفشل إذا ظهرت **أي قيمة من مخزن اعتمادات المالك** داخل هذا المستودع.
 *
 * لماذا: وُجد في جولة سابقة ملفّ يعمل ببروتوكول التنقيح يحمل **المفتاح السرّي لتوقيع كوكي المصادقة**
 * مكتوبًا نصًّا (المصدر: `.dsh/.credentials.yaml`). القيمة لم تُلتزم ولا تُدفع — لكن الحارس يمنع تكرارها.
 *
 * القواعد:
 *   - لا تُطبع أي قيمة سرّية إطلاقًا: يُذكر **الملفّ والسطر** وبصمة قصيرة (8 أحرف من SHA-256).
 *   - يستثني: node_modules · .git · agent-kit · .tmp (كلها ليست شحنًا).
 *   - يقرأ المخزن من `$USERPROFILE/.dsh/.credentials.yaml` (أو `$HOME`). إن تعذّرت قراءته ⇒ **يفشل بـ2**
 *     (لا يمرّ صامتًا) كي لا يتحوّل غياب الفحص إلى طمأنينة كاذبة.
 *   - يُرجع 0 نظيف · 1 تسرّب قيمة اعتماد · 2 تعذّر الفحص.
 *
 * التشغيل:  node tools/leak-check.mjs            (من جذر المستودع)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'

const HOME = process.env.USERPROFILE || process.env.HOME
const CRED = join(HOME, '.dsh', '.credentials.yaml')
const SKIP = /(^|[\\/])(node_modules|\.git|agent-kit|\.tmp)([\\/]|$)/
const MIN_VALUE = 12
const MAX_FILE = 4 * 1024 * 1024

const fp = (v) => createHash('sha256').update(v).digest('hex').slice(0, 8)

let values = []
try {
	const text = readFileSync(CRED, 'utf8')
	for (const line of text.split(/\r?\n/)) {
		const m = line.match(/^\s*(?:-\s*)?([A-Za-z0-9_.-]+)\s*:\s*(.+?)\s*$/)
		if (!m) continue
		const value = m[2].replace(/^["']|["']$/g, '')
		if (value.length < MIN_VALUE) continue
		if (/^(true|false|null|~|-)$/i.test(value)) continue
		values.push({ name: m[1], value })
	}
} catch (error) {
	console.error('leak-check: cannot read ' + CRED + ' — ' + String((error && error.message) || error))
	console.error('leak-check: refusing to report clean without reading the store (exit 2)')
	process.exit(2)
}
if (values.length === 0) {
	console.error('leak-check: the credentials store holds no comparable value (exit 2)')
	process.exit(2)
}

const leaks = []
const warnings = []
const walk = (dir) => {
	let entries
	try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
	for (const entry of entries) {
		const path = join(dir, entry.name)
		if (SKIP.test(path)) continue
		if (entry.isDirectory()) { walk(path); continue }
		if (!entry.isFile()) continue
		let size = 0
		try { size = statSync(path).size } catch { continue }
		if (size === 0 || size > MAX_FILE) continue
		let text
		try { text = readFileSync(path, 'utf8') } catch { continue }
		for (const { name, value } of values) {
			let at = text.indexOf(value)
			while (at !== -1) {
				leaks.push({ file: relative(process.cwd(), path), line: text.slice(0, at).split('\n').length, name, fp: fp(value) })
				at = text.indexOf(value, at + 1)
			}
		}
		// نمط ثانٍ: توقيع كوكي مصادقة مبنيّ يدويًّا (بلا قيمة سرّية ظاهرة، لكنه خطر تصميمي).
		// يُستثنى الحارس نفسه لأنه يحمل النمط وصفًا لا تنفيذًا.
		if (path.endsWith('leak-check.mjs')) continue
		const forge = text.match(/dsh-auth-['"]?\s*\+|rawSecret|createHmac\([^)]*\)[\s\S]{0,80}?dsh-auth-/g)
		if (forge) warnings.push({ file: relative(process.cwd(), path), count: forge.length })
	}
}
walk(process.cwd())

const describe = (v) => (v.file + ':' + v.line + '  (' + v.name + ' · ' + v.fp + ')')
if (warnings.length) {
	console.log('WARN — cookie signing built by hand (allowed only if it reads the secret at runtime):')
	for (const w of warnings) console.log('  ' + w.file + ' (' + w.count + ')')
}
if (leaks.length) {
	console.error('FAIL — credential value found in the repository (' + leaks.length + '):')
	for (const leak of leaks) console.error('  ' + describe(leak))
	console.error('Fix: never embed a credential — read it at runtime (env or the credentials store),')
	console.error('and the live prover should use the host\'s ephemeral ?token= instead of signing cookies.')
	process.exit(1)
}
console.log('LEAK-CHECK CLEAN — no credential value appears in the repository (' + values.length + ' value(s) compared)')
