import { beforeEach, describe, expect, it, vi } from 'vitest'

// A35: the OTA confirm (Capgo notifyAppReady) must fire from App's mount effect regardless of
// auth/network state. No DOM lib in this package, so effects are run inline and App() is called
// as a plain function (it only calls useAuth + useEffect itself).
const h = vi.hoisted(() => ({
  auth: { user: null as unknown, ready: false, terminalState: 'bound' as string },
  notify: vi.fn(async () => {}),
  hide: vi.fn(async () => {}),
}))

vi.mock('react', async (orig) => {
  const actual = await orig<typeof import('react')>()
  return { ...actual, useEffect: (fn: () => void) => void fn() }
})
vi.mock('./auth', () => ({ useAuth: () => h.auth }))
vi.mock('./native', () => ({ hideSplash: h.hide, otaNotifyReady: h.notify }))
vi.mock('./cashier/SyncProvider', () => ({ SyncProvider: () => null }))
vi.mock('./cashier/CashierScreen', () => ({ default: () => null }))
vi.mock('./screens/OutletPickScreen', () => ({ default: () => null }))
vi.mock('./screens/OutletMismatchScreen', () => ({ default: () => null }))

beforeEach(() => {
  h.notify.mockClear()
  h.auth = { user: null, ready: false, terminalState: 'bound' }
})

describe('OTA confirm is not gated on auth or network (A35)', () => {
  it('confirms while auth is still loading (ready=false)', async () => {
    const { default: App } = await import('./App')
    App()
    expect(h.notify).toHaveBeenCalledTimes(1)
  })
  it('confirms for a logged-out tablet (ready, no user)', async () => {
    h.auth = { user: null, ready: true, terminalState: 'bound' }
    const { default: App } = await import('./App')
    App()
    expect(h.notify).toHaveBeenCalledTimes(1)
  })
})
