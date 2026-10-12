// Production-APK debug gate (A34 G1), pure module; CLI is release_debug_gate_cli.mjs.
// Text-level checks, no dependencies.
// Capacitor loggingBehavior: 'debug' (default) = logs only in debug builds,
// 'none' = never, 'production' = ALWAYS logs, so only 'production' is flagged.
// A release gate must not miss real violations; false alarms are acceptable,
// so any value that is not a recognised safe literal is a violation.

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
      if (end === -1) throw new Error('unterminated block comment')
      i = end + 2
      out += ' '
    } else {
      out += c
      i++
    }
  }
  return out
}

// Values of every `key: value` / `'key': value` / `['key']: value` property
// (value up to , } or newline).
function propertyValues(text, key) {
  const re = new RegExp(
    String.raw`(?<![.\w$])\[?\s*['"]?${key}['"]?\s*\]?\s*:\s*([^,}\n]*)`,
    'g',
  )
  return [...text.matchAll(re)].map((m) => m[1].trim())
}

// Bare `key` used as an object shorthand property (`{ key }`, `{ key,`, `, key }`).
function hasShorthand(text, key) {
  return new RegExp(String.raw`(?<![.\w$'"])${key}\s*(?=[,}])`).test(text)
}

function strip(text, file, violations) {
  try {
    return stripComments(text)
  } catch (e) {
    violations.push(`could not parse ${file} safely (${e.message})`)
    return null
  }
}

export function checkReleaseDebug({ capacitorConfig, syncProvider }) {
  const violations = []
  const cfg = strip(capacitorConfig, 'capacitor.config.ts', violations)
  const sync = strip(syncProvider, 'SyncProvider.tsx', violations)

  if (cfg !== null) {
    const web = 'webContentsDebuggingEnabled'
    if (propertyValues(cfg, web).some((v) => v !== 'false')) {
      violations.push('android.webContentsDebuggingEnabled is not literally false')
    }
    if (hasShorthand(cfg, web)) {
      violations.push(`${web} set via shorthand/non-literal`)
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
    if (hasShorthand(cfg, 'loggingBehavior')) {
      violations.push('loggingBehavior set via shorthand/non-literal')
    }
  }
  if (sync !== null) {
    if (propertyValues(sync, 'debug').some((v) => v !== 'false' && v !== 'import.meta.env.DEV')) {
      violations.push(
        'SyncProvider passes a debug value to SyncEngine other than false or import.meta.env.DEV',
      )
    }
    if (hasShorthand(sync, 'debug')) {
      violations.push('SyncProvider debug set via shorthand/non-literal')
    }
  }
  return violations
}
