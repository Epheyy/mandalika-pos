// Pure parsing helper. Exact versions are checked; no lifecycle scripts or network.
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const root = process.argv[2]
const mode = process.argv[3]
const req = createRequire(path.resolve(root, 'package.json'))
const pins = { yaml: '2.9.1', semver: '7.8.5', 'spdx-expression-parse': '5.0.0' }
for (const [name, version] of Object.entries(pins)) {
  if (req(`${name}/package.json`).version !== version) throw new Error(`Unpinned parser ${name}`)
}
const input = JSON.parse(fs.readFileSync(0, 'utf8'))
let output
if (mode === 'lock') {
  output = req('yaml').parse(input.text, { uniqueKeys: true, maxAliasCount: 50 })
  if (String(output.lockfileVersion) !== '9.0') throw new Error('Unsupported pnpm lock schema')
} else if (mode === 'licenses') {
  const parse = req('spdx-expression-parse')
  output = input.map(expression => {
    if (typeof expression !== 'string' || /LicenseRef-|DocumentRef-|NOASSERTION|UNLICENSED|proprietary|unknown/i.test(expression)) return false
    try { parse(expression); return true } catch { return false }
  })
} else if (mode === 'ranges') {
  const semver = req('semver')
  output = input.map(({ version, range }) => ({
    valid: typeof range === 'string' && range.trim() !== '' && range.trim() !== '*' && semver.validRange(range) !== null,
    matches: typeof version === 'string' && typeof range === 'string' && semver.satisfies(version, range, { includePrerelease: true }),
  }))
} else throw new Error('Unknown parsing mode')
process.stdout.write(JSON.stringify(output))
