import { describe, expect, it } from 'vitest'
import { cancelIngredientTransferConfirm, cancelReason, sendIngredientTransferConfirm } from './ingredientTransferConfirm'

const transfer = (status: string) => ({
  transferNo: 'ITR-3',
  status: status as 'draft',
  source: { kind: 'warehouse' as const, id: 'w1', name: 'Gudang Pusat' },
  items: [{}, {}] as never,
})

describe('ingredient transfer confirms', () => {
  it('Kirim says the stock leaves the source now', () => {
    const c = sendIngredientTransferConfirm(transfer('draft'))
    expect(c.title).toBe('Kirim transfer ITR-3?')
    expect(c.consequence).toBe('Stok 2 jenis bahan akan keluar dari Gudang Pusat sekarang.')
  })

  it('Batalkan returns stock only for a sent transfer and asks the reason in the dialog', () => {
    expect(cancelIngredientTransferConfirm(transfer('draft')).consequence).toBe('Draf transfer dibatalkan. Stok tidak berubah.')
    const sent = cancelIngredientTransferConfirm(transfer('in_transit'))
    expect(sent.consequence).toBe('Stok 2 jenis bahan dikembalikan ke Gudang Pusat sekarang.')
    expect(sent.tone).toBe('danger')
    expect(sent.input?.label).toBe('Alasan pembatalan')
  })

  it('an empty reason falls back to Dibatalkan', () => {
    expect(cancelReason('  Salah input ')).toBe('Salah input')
    expect(cancelReason('')).toBe('Dibatalkan')
    expect(cancelReason(undefined)).toBe('Dibatalkan')
  })
})
