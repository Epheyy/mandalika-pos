import { beforeEach, describe, expect, it, vi } from 'vitest'

// No DOM lib in this package: hooks are stubbed and PrinterProvider is called as a plain
// function, then the context value is read off the returned element.
const h = vi.hoisted(() => ({ kind: 'none' as string }))

vi.mock('react', async (orig) => {
  const actual = await orig<typeof import('react')>()
  return {
    ...actual,
    useRef: (v: unknown) => ({ current: v }),
    useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => {}],
    useCallback: (fn: unknown) => fn,
    useMemo: (fn: () => unknown) => fn(),
  }
})
vi.mock('@mandalika/printer', () => ({
  createTransport: () => ({ kind: h.kind }),
  printReceipt: vi.fn(),
  printRecap: vi.fn(),
  printTandaTerima: vi.fn(),
}))
vi.mock('@mandalika/sync', () => ({
  getKV: () => ({ get: () => null, set: () => {}, remove: () => {} }),
}))

async function supportedFor(kind: string): Promise<boolean> {
  h.kind = kind
  const { PrinterProvider } = await import('./printer')
  const el = PrinterProvider({ children: null }) as unknown as { props: { value: { supported: boolean } } }
  return el.props.value.supported
}

beforeEach(() => {
  h.kind = 'none'
})

describe('PrinterProvider supported flag', () => {
  it('is true for the bluetooth-auto transport', async () => {
    expect(await supportedFor('bluetooth-auto')).toBe(true)
  })
  it('is true for capacitor-ble', async () => {
    expect(await supportedFor('capacitor-ble')).toBe(true)
  })
  it('is false for none', async () => {
    expect(await supportedFor('none')).toBe(false)
  })
})
