import { afterEach, describe, expect, it, vi } from 'vitest'
import { confirmLeave, pushLeaveGuard } from '../../lib/navGuard'
import type { ConfirmOptions } from '../../ui/ConfirmDialog'
import { BAHAN_SCOPE, makeCountAskLeave } from './useCountLeaveGuard'

const offs: Array<() => void> = []
afterEach(() => offs.splice(0).forEach((off) => off()))

const guardWith = (confirmed: boolean, rows = 2) => {
  const ask = vi.fn(async (opts: ConfirmOptions) => ({ confirmed, title: opts.title }))
  offs.push(pushLeaveGuard(makeCountAskLeave(() => rows, ask), { scope: BAHAN_SCOPE }))
  return ask
}

describe('ingredient count leave guard', () => {
  it('asks when switching Bahan to Produk, naming the unsaved rows', async () => {
    const ask = guardWith(false, 3)
    await confirmLeave(['inventori', 'opname', 'produk'])
    expect(ask).toHaveBeenCalledOnce()
    expect(ask.mock.calls[0][0].consequence).toContain('3 bahan')
  })

  it('"Lanjut edit" stays on Bahan', async () => {
    guardWith(false)
    expect(await confirmLeave(['inventori', 'opname', 'produk'])).toBe(false)
  })

  it('"Tinggalkan dan buang" lets the switch through', async () => {
    guardWith(true)
    expect(await confirmLeave(['inventori', 'opname', 'produk'])).toBe(true)
  })

  it('asks for the sidebar and for sign-out, not for a move inside Bahan', async () => {
    const ask = guardWith(false)
    expect(await confirmLeave(['laporan'])).toBe(false)
    expect(await confirmLeave()).toBe(false)
    expect(ask).toHaveBeenCalledTimes(2)
    expect(await confirmLeave(['inventori', 'opname', 'bahan'])).toBe(true)
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('asks nothing when no guard is pushed (nothing unsaved)', async () => {
    expect(await confirmLeave(['inventori', 'opname', 'produk'])).toBe(true)
  })
})
