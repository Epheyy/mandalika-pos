// Summarise `log_min_duration_statement` lines of the Postgres container log by statement.
// Usage: docker logs roletest-postgres-1 --since 4h > loadtest/out/pglog.txt 2>&1
//        node loadtest/slowlog.mjs loadtest/out/pglog.txt [minAvgMs=300] [--full N]   (--full N prints statement N in full)
import { readFileSync } from 'node:fs'

const [file, minArg = '300', ...rest] = process.argv.slice(2)
const lines = readFileSync(file, 'utf8').split('\n')
const stamp = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+ UTC \[\d+\] (\w+):/
const entries = []
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/LOG:  duration: ([\d.]+) ms +(?:statement|execute [^:]*): ?(.*)$/)
  if (!m) continue
  let sql = m[2]
  let j = i + 1
  while (j < lines.length && !stamp.test(lines[j])) sql += '\n' + lines[j++]
  const detail = lines[j]?.includes('DETAIL:  parameters') ? lines[j] : ''
  entries.push({ ms: +m[1], sql: sql.trim(), detail })
}
const groups = new Map()
for (const e of entries) {
  const key = e.sql.replace(/\s+/g, ' ').replace(/'[^']*'/g, "'?'").slice(0, 100)
  const g = groups.get(key) ?? { key, n: 0, total: 0, max: 0, sample: e }
  g.n++; g.total += e.ms
  if (e.ms > g.max) { g.max = e.ms; g.sample = e }
  groups.set(key, g)
}
const list = [...groups.values()].filter((g) => g.total / g.n >= +minArg).sort((a, b) => b.total - a.total)
const fi = rest.indexOf('--full')
const ei = rest.indexOf('--explain')
if (ei >= 0) {
  // Emit EXPLAIN (ANALYZE, BUFFERS) for statement N with its logged parameters substituted as literals.
  const g = list[+rest[ei + 1]]
  const params = {}
  for (const m of g.sample.detail.matchAll(/\$(\d+) = ('(?:[^']|'')*'|NULL)/g)) params[m[1]] = m[2]
  console.log('EXPLAIN (ANALYZE, BUFFERS)\n' + g.sample.sql.replace(/\$(\d+)/g, (_, n) => params[n] ?? 'NULL'))
} else if (fi >= 0) {
  const g = list[+rest[fi + 1]]
  console.log(g.sample.sql + '\n' + g.sample.detail)
} else {
  list.forEach((g, i) => console.log(`#${i}\tn=${g.n}\tavg=${(g.total / g.n).toFixed(0)}ms\tmax=${g.max.toFixed(0)}ms\t${g.key}`))
}
