// Production-APK debug gate (A34 G1). Text-level checks, no dependencies.
// Capacitor loggingBehavior: 'debug' (default) = logs only in debug builds,
// 'none' = never, 'production' = ALWAYS logs, so only 'production' is flagged.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

export function checkReleaseDebug({ capacitorConfig, syncProvider }) {
  const violations = []
  const cfg = stripComments(capacitorConfig)
  const sync = stripComments(syncProvider)

  if (/\bwebContentsDebuggingEnabled\s*:\s*true\b/.test(cfg)) {
    violations.push('android.webContentsDebuggingEnabled is true')
  }
  if (/\bloggingBehavior\s*:\s*['"]production['"]/.test(cfg)) {
    violations.push(
      "loggingBehavior 'production' logs in release builds; use 'debug' (default) or 'none'",
    )
  }
  if (/\bdebug\s*:\s*true\b/.test(sync)) {
    violations.push('SyncProvider passes debug: true to SyncEngine')
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
