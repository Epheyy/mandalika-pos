// Regenerates packages/sync/src/__fixtures__/redact-phone-corpus.json (A37).
//
//   node --experimental-strip-types scripts/gen-redact-phone-corpus.mjs
//
// A seeded (mulberry32, SEED below) fuzzer: it builds Indonesian phone numbers in many
// groupings, separators (space, '-', '.', '/', en dash, NBSP, double separators) and prefix
// styles (0, 62, +62, parenthesised variants), puts them in many surroundings (after letters,
// after other numbers, followed by numbers, in adjacent pairs) and records
//   { input, phoneDigits: [digit strings that must not survive], expected }
// where `expected` is the TypeScript redactor's output (redactString, logs tier).
//
// The generator also ASSERTS the fail-closed property while it runs: after redaction, with
// separators stripped, none of the phone digit strings may appear. A leak aborts generation,
// so this script doubles as a fuzz test of the scanner. Both packages/sync/src/redact.test.ts
// and backend/internal/redact/redact_test.go load the committed file and check the same two
// facts (no phone digits survive; output == expected), so TS/Go parity is a committed test.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { redactString } from '../packages/sync/src/redact.ts'

const SEED = 20261017
const CASES = 1800

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rnd = mulberry32(SEED)
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1))
const pick = (arr) => arr[int(0, arr.length - 1)]

const SEPS = [' ', ' ', ' ', '-', '-', '.', '/', '\u2013', '\u00a0', '\u2011', '\u2212', '\u202f', '\u2009', '_', ' - ', ' \u2013 ']
const sep = () => (rnd() < 0.1 ? pick(SEPS) + pick(SEPS) : pick(SEPS))

function groups(nat, firstMin) {
  const out = []
  let i = 0
  while (i < nat.length) {
    const size = Math.min(int(i === 0 ? firstMin : 2, 5), nat.length - i)
    out.push(nat.slice(i, i + size))
    i += size
  }
  return out
}

function phone() {
  const natLen = int(9, 12)
  let nat = '8'
  while (nat.length < natLen) nat += String(int(0, 9))
  const style = pick(['0', '0', '62', '+62', '(0)', '(+62)', '+62(8)', '0062', '+62(0)', '62+0'])
  let text
  let digits
  if (style === '0' || style === '(0)') {
    const g = groups(nat, 2)
    g[0] = '0' + g[0]
    digits = '0' + nat
    text = style === '0' ? g.join(sep()) : '(' + g[0] + ')' + pick([' ', ' ', '']) + g.slice(1).join(sep())
    if (style === '(0)' && g.length === 1) text = '(' + g[0] + ')'
  } else {
    const g = groups(nat, 1)
    digits = nat
    const lead = style === '62' || style === '62+0' ? '62' : style === '0062' ? '0062' : '+62'
    const trunk = style === '62+0' ? '0' : style === '+62(0)' ? '(0)' : style === '0062' && rnd() < 0.5 ? '0' : ''
    const between = style === '(+62)' ? ') ' : style === '+62(8)' ? ' (' : pick(['', ' ', '-', ' ', '  ']) + trunk
    if (style === '(+62)') text = '(' + lead + between + g.join(sep())
    else if (style === '+62(8)') text = lead + between + g[0] + ') ' + g.slice(1).join(sep())
    else text = lead + between + g.join(sep())
  }
  return { text, digits }
}

const LEADS = ['', '', 'HP ', 'Telp: ', 'WA ', 'Budi-', 'Hp', 'tel:', '2024 ', '08 2024 ', '62 8000 ', 'stock 1234 ', 'Rp 62.000 ', 'kontak (', 'No.', 'order 17-10-2026 ']
const TRAILS = ['', '', '.', ', ok', ' 100000', ' 123', ' terima kasih', ')', ' Rp 50.000', ' / 5', ';x']

const cases = []
const seen = new Set()
while (cases.length < CASES) {
  const a = phone()
  const parts = [pick(LEADS), a.text]
  const digitsList = [a.digits]
  if (rnd() < 0.2) {
    const b = phone()
    parts.push(pick([' ', ' / ', ', ', ' dan ']), b.text)
    digitsList.push(b.digits)
  }
  parts.push(pick(TRAILS))
  const input = parts.join('')
  if (seen.has(input)) continue
  seen.add(input)
  const expected = redactString(input, 'logs')
  const stripped = expected.replace(/[ \t.\-\u2013\u2014\u2011\u2212\u202f\u2009/()_\u00a0]/g, '')
  for (const d of digitsList) {
    if (stripped.includes(d)) {
      console.error(`LEAK: ${JSON.stringify(input)} -> ${JSON.stringify(expected)} (digits ${d})`)
      process.exit(1)
    }
  }
  cases.push({ input, phoneDigits: digitsList, expected })
}

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'sync', 'src', '__fixtures__', 'redact-phone-corpus.json')
const body = '{\n "seed": ' + SEED + ',\n "generator": "scripts/gen-redact-phone-corpus.mjs",\n "cases": [\n' +
  cases.map((c) => '  ' + JSON.stringify(c)).join(',\n') + '\n ]\n}\n'
fs.writeFileSync(out, body, 'utf8')
console.log(`wrote ${cases.length} cases to ${out}`)
