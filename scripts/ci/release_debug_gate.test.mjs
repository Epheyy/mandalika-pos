import test from 'node:test'
import assert from 'node:assert/strict'
import { checkReleaseDebug } from './release_debug_gate.mjs'

const cfg = (android = '', logging = "loggingBehavior: 'debug',") =>
  `const config = { android: { ${android} }, ${logging} }`
const sync = (debug) => `new SyncEngine(api, { ${debug} onDeadLetter: x })`

test('current-style test config yields webContentsDebugging and SyncProvider violations', () => {
  const v = checkReleaseDebug({
    capacitorConfig: cfg('webContentsDebuggingEnabled: true,'),
    syncProvider: sync('debug: true,'),
  })
  assert.equal(v.length, 2)
})

test('loggingBehavior production is a violation', () => {
  const v = checkReleaseDebug({
    capacitorConfig: cfg('', "loggingBehavior: 'production',"),
    syncProvider: sync('debug: import.meta.env.DEV,'),
  })
  assert.equal(v.length, 1)
  assert.match(v[0], /loggingBehavior/)
})

test('clean config is accepted (debug, none, absent logging; DEV/false debug)', () => {
  for (const logging of ["loggingBehavior: 'debug',", "loggingBehavior: 'none',", '']) {
    assert.deepEqual(
      checkReleaseDebug({
        capacitorConfig: cfg('webContentsDebuggingEnabled: false,', logging),
        syncProvider: sync('debug: import.meta.env.DEV,'),
      }),
      [],
    )
  }
  assert.deepEqual(
    checkReleaseDebug({ capacitorConfig: cfg(), syncProvider: sync('debug: false,') }),
    [],
  )
})

test('violations inside comments are ignored', () => {
  assert.deepEqual(
    checkReleaseDebug({
      capacitorConfig:
        cfg('/* webContentsDebuggingEnabled: true, */') +
        "\n// loggingBehavior: 'production',",
      syncProvider: sync('// debug: true,\n debug: false,'),
    }),
    [],
  )
})

const syncOk = sync('debug: false,')
const check = (capacitorConfig, syncProvider = syncOk) =>
  checkReleaseDebug({ capacitorConfig, syncProvider })

test('string containing // or /* before the key does not hide a violation', () => {
  assert.equal(
    check(`const u = 'https://x'; const config = { android: { webContentsDebuggingEnabled: true } }`).length,
    1,
  )
  assert.equal(
    check(`const g = 'dist/*'; const config = { android: { webContentsDebuggingEnabled: true } }`).length,
    1,
  )
  assert.equal(check(`const g = "a//b"; const c = { loggingBehavior: 'production' }`).length, 1)
})

test('quoted keys are matched', () => {
  assert.equal(check(`{ "webContentsDebuggingEnabled": true }`).length, 1)
  assert.equal(check(`{ 'loggingBehavior': 'production' }`).length, 1)
  assert.equal(
    check(`{}`, `new SyncEngine(api, { 'debug': true })`).length,
    1,
  )
})

test('non-literal-false values are violations', () => {
  assert.equal(check(`{ webContentsDebuggingEnabled: !0 }`).length, 1)
  assert.equal(check(`{ webContentsDebuggingEnabled: process.env.X ? true : false }`).length, 1)
  assert.equal(check(`{ loggingBehavior: process.env.LOG }`).length, 1)
  assert.equal(check(`{}`, `{ debug: !!window.x }`).length, 1)
})

test('literal false / DEV values and absent keys are OK', () => {
  assert.deepEqual(check(`{ webContentsDebuggingEnabled: false, loggingBehavior: "none" }`), [])
  assert.deepEqual(check(`{}`, `{ debug: import.meta.env.DEV }`), [])
  assert.deepEqual(check(`{}`, `{ onWall: x }`), [])
})

test('unterminated block comment (scanner out of sync) fails closed', () => {
  const lost =
    'const a = `${ f(`/*`) }`; const c = { webContentsDebuggingEnabled: true }'
  const v = check(lost)
  assert.ok(v.length >= 1)
  assert.match(v.join('\n'), /could not parse/)
  assert.ok(check(`{}`, '/* never closed\n debug: false').length >= 1)
})

test('shorthand keys are violations', () => {
  assert.equal(check(`{ webContentsDebuggingEnabled }`).length, 1)
  assert.equal(check(`{ android: { webContentsDebuggingEnabled, x: 1 } }`).length, 1)
  for (const s of ['{ debug }', 'x({ onWall, debug })', 'x({ debug, onWall })', 'x({\n debug\n})']) {
    assert.equal(check(`{}`, s).length, 1, s)
  }
})

test('computed keys are matched', () => {
  assert.equal(check(`{ ["webContentsDebuggingEnabled"]: true }`).length, 1)
  assert.equal(check(`{}`, `x({ ['debug']: true })`).length, 1)
  assert.deepEqual(check(`{ ["webContentsDebuggingEnabled"]: false }`), [])
})

test('member access and calls named debug are not shorthand', () => {
  assert.deepEqual(check(`{}`, `console.debug('x'); log.debug(a, b)`), [])
})
