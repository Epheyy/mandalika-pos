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

  it('routes the hook toasts through a tone-by-wording wrapper', () => {
    expect(src.match(/showToast: hookToast/g)).toHaveLength(3)
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
