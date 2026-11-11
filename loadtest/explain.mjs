// Run a SQL file (typically EXPLAIN (ANALYZE, BUFFERS) ...) in mandalika_load and print the plan.
// Usage: node loadtest/explain.mjs file.sql [--summary]   (--summary keeps only scan/sort/timing lines)
import { readFileSync } from 'node:fs'
import { psql } from './lib.mjs'

const [file, flag] = process.argv.slice(2)
const out = psql(readFileSync(file, 'utf8'))
const keep = /Execution Time|Planning Time|Scan|Sort|WindowAgg|Gather|Aggregate|Limit|Hash|Buffers: shared/
console.log(flag === '--summary' ? out.split('\n').filter((l) => keep.test(l)).map((l) => l.slice(0, 200)).join('\n') : out)
