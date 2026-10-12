// CLI for the production-APK debug gate. Always runs (no main-guard) and
// fails closed: any error, such as an unreadable file, exits 1.
import { readFileSync } from 'node:fs'
import { checkReleaseDebug } from './release_debug_gate.mjs'

try {
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
} catch (e) {
  console.log(`::error::release debug gate failed: ${e.message}`)
  process.exit(1)
}
