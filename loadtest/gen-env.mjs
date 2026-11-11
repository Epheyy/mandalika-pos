// Writes backend/.env (gitignored) with local-only secrets for the load-test backend.
// Run from the repo root: node loadtest/gen-env.mjs   (never prints the secrets)
import { randomBytes } from 'node:crypto'
import { writeFileSync, existsSync } from 'node:fs'

const target = new URL('../backend/.env', import.meta.url)
if (existsSync(target) && !process.argv.includes('--force')) {
  console.log('backend/.env exists; pass --force to overwrite')
  process.exit(0)
}
const hex = (n) => randomBytes(n).toString('hex')
const lines = [
  'DATABASE_URL=postgres://mandalika:mandalika@localhost:5433/mandalika_load?sslmode=disable',
  'REDIS_URL=redis://localhost:6379/1',
  'PORT=8090',
  'ENV=development',
  'TRUSTED_PROXY_HOPS=0',
  `JWT_ACCESS_SECRET=${hex(32)}`,
  `JWT_REFRESH_SECRET=${hex(32)}`,
  `SEED_ADMIN_PASSWORD=${randomBytes(18).toString('base64url')}`,
  // Load-test only: all traffic is one IP, so the global per-IP bucket is raised.
  'RATE_LIMIT_RPS=100000',
  'RATE_LIMIT_BURST=100000',
  '',
]
writeFileSync(target, lines.join('\n'))
console.log('wrote backend/.env')
