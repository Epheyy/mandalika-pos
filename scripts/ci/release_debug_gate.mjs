// Production-APK debug gate (A34 G1). Text-level checks, no dependencies.
// Capacitor loggingBehavior: 'debug' (default) = logs only in debug builds,
// 'none' = never, 'production' = ALWAYS logs, so only 'production' is flagged.
// A release gate must not miss real violations; false alarms are acceptable,
// so any value that is not a recognised safe literal is a violation.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Remove // and /* */ comments while leaving string/template literals intact.
export function stripComments(text) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    const n = text[i + 1]
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
      out += ' '
    } else {
      out += c
      i++
    }
  }
  return out
}

// Values of every `key: value` / `'key': value` property (value up to , } or newline).
function propertyValues(text, key) {
  const re = new RegExp(
    String.raw`(?<![.\w$])['"]?${key}['"]?\s*:\s*([^,}\n]*)`,
    'g',
  )
  return [...text.matchAll(re)].map((m) => m[1].trim())
}

export function checkReleaseDebug({ capacitorConfig, syncProvider }) {
  const violations = []
  const cfg = stripComments(capacitorConfig)
  const sync = stripComments(syncProvider)

  if (propertyValues(cfg, 'webContentsDebuggingEnabled').some((v) => v !== 'false')) {
    violations.push('android.webContentsDebuggingEnabled is not literally false')
  }
  for (const v of propertyValues(cfg, 'loggingBehavior')) {
    if (/^['"]production['"]$/.test(v)) {
      violations.push(
        "loggingBehavior 'production' logs in release builds; use 'debug' (default) or 'none'",
      )
    } else if (!/^['"](debug|none)['"]$/.test(v)) {
      violations.push("loggingBehavior must be a literal 'debug' or 'none'")
    }
  }
  if (propertyValues(sync, 'debug').some((v) => v !== 'false' && v !== 'import.meta.env.DEV')) {
    violations.push('SyncProvider passes a debug value to SyncEngine other than false or import.meta.env.DEV')
  }
  return violations
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = checkReleaseDebug({
    capacitorConfig: readFileSync('apps/pos/capacitor.config.ts', 'utf8'),
    syncProvider: readFileSync('apps/pos/src/cashier/SyncProvider.tsx', 'utf8'),
  })
  if (violations.length > 0) {
    for (const v of violations) console.log(`::error::${v}`)
    console.log(`release debug gate: ${violations.length} violation(s); production build refused`)
    process.exit(1)
  }
  console.log('release debug gate: clean')
}
