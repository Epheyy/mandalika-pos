import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// A04 wiring: these guard the places where one forgotten call would silently bring back
// flush-time attribution (header outlet switcher, ad hoc authStore.outletId, an engine
// without an actor provider, logout buttons, auto-open on a failed fetch).

const SRC = fileURLToPath(new URL('.', import.meta.url))
const read = (p: string) => readFileSync(join(SRC, p), 'utf8')

function sources(dir = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return sources(full)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : []
  })
}
const rel = (f: string) => relative(SRC, f).replaceAll('\\', '/')

describe('fixed terminal wiring (A04)', () => {
  it('the header outlet switcher is gone and nothing imports it', () => {
    expect(existsSync(join(SRC, 'components/OutletSwitcher.tsx'))).toBe(false)
    const importers = sources().filter((f) => /OutletSwitcher/.test(readFileSync(f, 'utf8')))
    expect(importers.map(rel)).toEqual([])
  })

  it('authStore.outletId is only ever assigned from the terminal binding (or cleared) in auth.tsx', () => {
    const assigners = sources().filter((f) => /authStore\.outletId\s*=(?!=)/.test(readFileSync(f, 'utf8')))
    expect(assigners.map(rel)).toEqual(['auth.tsx'])
    const lines = read('auth.tsx').split('\n').filter((l) => /authStore\.outletId\s*=(?!=)/.test(l)).map((l) => l.trim())
    expect(lines).toEqual(['authStore.outletId = null', "authStore.outletId = res.state === 'ok' && res.binding ? res.binding.outletId : null"])
  })

  it('boot, offline restore, sign-in and token refresh all settle the terminal, and only sign-in/pick are "fresh"', () => {
    const auth = read('auth.tsx')
    expect(auth).toMatch(/const apply = useCallback\([\s\S]*?settleTerminal\(d\.user, \{ fresh \}\)/)
    expect(auth).toMatch(/authStore\.onTokens = [\s\S]*?settleTerminal\(d\.user\)\.catch/)
    expect(auth).toMatch(/r\.kind === 'offline'[\s\S]*?settleTerminal\(r\.user\)\.catch/)
    expect(auth).toMatch(/checkLoginAllowed\(getOutboxStore\(\), d\.user\)[\s\S]*?throw new Error\(verdict\.message\)[\s\S]*?await apply\(d, true\)/)
    expect(auth).toMatch(/settleTerminal\(user, \{ picked: outlet, fresh: true \}\)/)
    // H2: the token-refresh and boot paths must never ask for fresh/cache-clearing binds.
    const onTokens = auth.slice(auth.indexOf('authStore.onTokens = '), auth.indexOf('// Only a server 401'))
    expect(onTokens).not.toMatch(/bfreshb/)
    expect(auth.slice(auth.indexOf('void bootSession'), auth.indexOf('.finally(() => setReady(true))'))).not.toMatch(/fresh: true|apply\(r\.data, true\)/)
  })

  it('a bound terminal is never rebound by the auth code: only resolveTerminal decides, and it does not rebind', () => {
    expect(read('auth.tsx')).not.toMatch(/bindingFor/)
    expect(read('auth.tsx')).toMatch(/resolveTerminal\(u, current, opts\.picked\)/)
  })

  it('unassigned, mismatch and pick are all stopped before the cashier screen', () => {
    expect(read('App.tsx')).toMatch(/terminalState === 'unassigned'\) return <OutletUnassignedScreen \/>[\s\S]*?terminalState === 'mismatch'\) return <SyncProvider flushOnly>[\s\S]*?terminalState === 'pick'\) return <OutletPickScreen \/>[\s\S]*?<SyncProvider>/)
    // no outlet in effect on a mismatch: requests carry none and actor() refuses
    expect(read('auth.tsx')).toMatch(/res\.state === 'ok' && res\.binding \? res\.binding\.outletId : null/)
  })

  it('a mismatch mounts a flush-only engine (so the queue can drain) and the screen offers Keluar', () => {
    expect(read('App.tsx')).toMatch(/terminalState === 'mismatch'\) return <SyncProvider flushOnly><OutletMismatchScreen \/><\/SyncProvider>/)
    const provider = read('cashier/SyncProvider.tsx')
    expect(provider).toMatch(/if \(flushOnly\) \{\s*setReady\(true\)/) // no snapshot pull for the account's outlet
    expect(provider).toMatch(/engine\.start\(12_000, \{ flushOnly \}\)/)
    const screen = read('screens/OutletMismatchScreen.tsx')
    expect(screen).toMatch(/onClick=\{logout\}/)
    expect(screen).toMatch(/queueSummary\(\)/)
    expect(screen).toMatch(/Minta admin mengembalikan outlet akun ke/)
  })

  it('the sync engine is built with the capture-time actor provider', () => {
    expect(read('cashier/SyncProvider.tsx')).toMatch(/\{\s*actor:\s*currentActor,\s*outboxStore:\s*getOutboxStore\(\)\s*\}/)
  })

  it('logout is not reachable from the cashier UI; the terminal entry opens Pengaturan', () => {
    expect(read('cashier/MenuDrawer.tsx')).not.toMatch(/onLogout/)
    expect(read('cashier/MenuDrawer.tsx')).toMatch(/onTerminal/)
    const users = sources().filter((f) => /\blogout\b/.test(readFileSync(f, 'utf8'))).map(rel).sort()
    // auth.tsx defines it (authBoot only mentions it in a comment); the pick and unassigned
    // screens offer an escape before any binding exists. Nothing in the cashier UI may call it.
    expect(users).toEqual(['App.tsx', 'auth.tsx', 'authBoot.ts', 'screens/OutletMismatchScreen.tsx', 'screens/OutletPickScreen.tsx'])
    expect(read('screens/OutletMismatchScreen.tsx')).toMatch(/releaseTerminal/)
  })

  it('Lepas terminal is guarded by the queue and reachability checks', () => {
    const section = read('screens/TerminalSection.tsx')
    expect(section).toMatch(/releaseBlockedReason\(/)
    expect(section).toMatch(/parkedUnstamped: summary\.parkedUnstamped/)
    expect(section).toMatch(/online: engine\.isReachable\(\)/)
    expect(read('auth.tsx')).toMatch(/releaseTerminal[\s\S]*?isQueueReleasable\(readQueueState\(getOutboxStore\(\)\)\)[\s\S]*?clearBinding\(kv\)[\s\S]*?clearOutletCaches\(kv, bound\?\.outletId\)/)
  })

  it('the shift header persists, overlays and only auto-opens after a successful fetch', () => {
    const hook = read('hooks/useShift.ts')
    expect(hook).toMatch(/readShiftCache\(getKV\(\), outletId\)/)
    expect(hook).toMatch(/writeShiftCache\(getKV\(\), outletId, r\.data\)/)
    expect(hook).toMatch(/overlayShift\(serverShift, ops/)
    expect(hook).toMatch(/shouldAutoOpen\(\{[\s\S]*?fetchedThisSession/)
    expect(hook).toMatch(/if \(!engine\.isReachable\(\) \|\| !fetchedThisSession\) \{[\s\S]*?OFFLINE_OPEN_MESSAGE/)
    // the old unconditional auto-open (gated only on "not loading, no shift") must not return
    expect(hook).not.toMatch(/if \(isLoadingShift \|\| currentShift \|\| isOpeningShift\) return/)
  })

  it('Buka Shift is disabled while offline', () => {
    expect(read('cashier/ShiftBar.tsx')).toMatch(/disabled=\{!canOpen\}/)
    expect(read('cashier/CashierScreen.tsx')).toMatch(/canOpen=\{shift\.canOpenShift\}/)
  })
})
