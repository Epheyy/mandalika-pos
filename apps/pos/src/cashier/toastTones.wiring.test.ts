import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createToastController } from '../components/ui/toastController'

// P6a: CashierScreen's showToast goes through the K3 toast. Refusals default to 'warn' (never dropped behind an oversell
// toast); plain confirmations must be 'info', or a "Ditambah: ..." scan toast (warn) would hide the refund success toast
// (ok) raised within its 3 s (POS-SPLIT-REFUND failed on exactly this).
describe('CashierScreen toast tones', () => {
  const src = readFileSync(new URL('./CashierScreen.tsx', import.meta.url), 'utf8')

  it('marks the scan/search add confirmation as info', () => {
    expect(src).toMatch(/`Ditambah: [^`]*`, 'info'\)/)
  })

  it('confirms a tile add with an info toast (D-93) so it can never block the refund success toast', () => {
    expect(src).toMatch(/`Ditambahkan · \$\{product\.name\}`, \{ tone: 'info', duration: ADD_TOAST_MS \}/)
    expect(src).toMatch(/const ADD_TOAST_MS = 1600/)
  })

  it('hands the hooks the tone-explicit showToast, with no wording regex', () => {
    expect(src).not.toMatch(/hookToast/)
    for (const hook of ['useHeldOrders', 'useSplitDraft', 'useOpenCartDraft']) {
      const h = readFileSync(new URL(`./${hook}.ts`, import.meta.url), 'utf8')
      expect(h).toMatch(/showToast: \(msg: string, tone: 'info' \| 'warn'\) => void/)
    }
  })

  it('keeps the held-order save confirmation info and its refusals warn', () => {
    const h = readFileSync(new URL('./useHeldOrders.ts', import.meta.url), 'utf8')
    expect(h).toMatch(/tersimpan di tablet ini`, 'info'\)/)
    expect(h).toMatch(/HELD_ORDERS_WRITE_MESSAGE, 'warn'\)/)
    expect(h).toMatch(/showToast\(locked, 'warn'\)/)
  })

  it('a warn toast would drop the ok refund toast (why confirmations must be info)', () => {
    const c = createToastController()
    c.show('Ditambah: X', { tone: 'warn' })
    expect(c.show('Refund diproses', { tone: 'ok' })).toBeNull()
    const d = createToastController()
    d.show('Ditambah: X', { tone: 'info' })
    expect(d.show('Refund diproses', { tone: 'ok' })).not.toBeNull()
  })
})
