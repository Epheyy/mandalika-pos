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
