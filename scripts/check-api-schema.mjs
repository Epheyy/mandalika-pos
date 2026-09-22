import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const schema = new URL('../packages/api/src/schema.d.ts', import.meta.url)
const before = readFileSync(schema)
const pnpm = process.env.npm_execpath
if (!pnpm) throw new Error('Run with corepack pnpm gen:check')
// Compare regeneration with the current file, not HEAD: local dirty worktrees
// are valid inputs. Restore exact original bytes even when drift is detected.
try {
  const result = spawnSync(process.execPath, [pnpm, '--filter', '@mandalika/api', 'gen'], {
    cwd: root, stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exitCode = result.status ?? 1
  else if (before.toString('utf8').replaceAll('\r\n', '\n') !== readFileSync(schema, 'utf8').replaceAll('\r\n', '\n')) {
    console.error('DRIFT: packages/api/src/schema.d.ts differs from OpenAPI regeneration. Run corepack pnpm --filter @mandalika/api gen and review/commit the result.')
    process.exitCode = 1
  } else console.log('TypeScript OpenAPI schema matches regeneration.')
} finally {
  writeFileSync(schema, before)
}
