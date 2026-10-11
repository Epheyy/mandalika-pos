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
    expect(lines).toEqual(['authStore.outletId = null', 'authStore.outletId = next?.outletId ?? null'])
  })

  it('boot, offline restore, sign-in and token refresh all settle the terminal', () => {
    const auth = read('auth.tsx')
    expect(auth).toMatch(/const apply = useCallback\([\s\S]*?settleTerminal\(d\.user\)/)
    expect(auth).toMatch(/authStore\.onTokens = [\s\S]*?settleTerminal\(d\.user\)/)
    expect(auth).toMatch(/r\.kind === 'offline'[\s\S]*?settleTerminal\(r\.user\)/)
    expect(auth).toMatch(/checkLoginAllowed\(getKV\(\), d\.user\)[\s\S]*?throw new Error\(verdict\.message\)[\s\S]*?apply\(d\)/)
  })

  it('the sync engine is built with the capture-time actor provider', () => {
    expect(read('cashier/SyncProvider.tsx')).toMatch(/\{\s*actor:\s*currentActor\s*\}/)
  })

  it('logout is not reachable from the cashier UI; the terminal entry opens Pengaturan', () => {
    expect(read('cashier/MenuDrawer.tsx')).not.toMatch(/onLogout/)
    expect(read('cashier/MenuDrawer.tsx')).toMatch(/onTerminal/)
    const users = sources().filter((f) => /\blogout\b/.test(readFileSync(f, 'utf8'))).map(rel).sort()
    // auth.tsx defines it (authBoot only mentions it in a comment); the pick screen offers
    // an escape before any binding exists. Nothing in the cashier UI may call it.
    expect(users).toEqual(['auth.tsx', 'authBoot.ts', 'screens/OutletPickScreen.tsx'])
  })

  it('Lepas terminal is guarded by the queue and reachability checks', () => {
    const section = read('screens/TerminalSection.tsx')
    expect(section).toMatch(/releaseBlockedReason\(/)
    expect(section).toMatch(/unsettled: engine\.unsettledCount\(\)/)
    expect(section).toMatch(/online: engine\.isReachable\(\)/)
    expect(read('auth.tsx')).toMatch(/releaseTerminal[\s\S]*?isQueueEmpty\(readQueueState\(kv\)\)[\s\S]*?clearBinding\(kv\)/)
  })

  it('the shift header persists, overlays and only auto-opens after a successful fetch', () => {
    const hook = read('hooks/useShift.ts')
    expect(hook).toMatch(/readShiftCache\(getKV\(\), outletId\)/)
    expect(hook).toMatch(/writeShiftCache\(getKV\(\), outletId, r\.data\)/)
    expect(hook).toMatch(/overlayShift\(serverShift, ops/)
    expect(hook).toMatch(/shouldAutoOpen\(\{[\s\S]*?fetchedThisSession/)
    expect(hook).toMatch(/if \(!engine\.isReachable\(\)\) \{[\s\S]*?OFFLINE_OPEN_MESSAGE/)
    // the old unconditional auto-open (gated only on "not loading, no shift") must not return
    expect(hook).not.toMatch(/if \(isLoadingShift \|\| currentShift \|\| isOpeningShift\) return/)
  })

  it('Buka Shift is disabled while offline', () => {
    expect(read('cashier/ShiftBar.tsx')).toMatch(/disabled=\{!isOnline\}/)
    expect(read('cashier/CashierScreen.tsx')).toMatch(/isOnline=\{offlineData\.isOnline\}/)
  })
})
