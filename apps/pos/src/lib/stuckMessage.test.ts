import { describe, expect, it } from 'vitest'
import { HOLD_SHIFT_MESSAGE, STUCK_RETRY_MESSAGE, stuckMessage } from './stuckMessage'

describe('stuckMessage', () => {
  it('uses the generic server message for ordinary stuck items', () => {
    expect(stuckMessage({ type: 'order', lastError: 'timeout' })).toBe(STUCK_RETRY_MESSAGE)
  })
  it('explains a shift close or open held behind earlier transactions', () => {
    const held = 'Tutup shift ditunda: ada transaksi sebelumnya yang belum tersimpan, akan dicoba ulang otomatis.'
    expect(stuckMessage({ type: 'shift_close', lastError: held })).toBe(HOLD_SHIFT_MESSAGE)
    expect(stuckMessage({ type: 'shift_open', lastError: 'Buka shift ditunda: ada transaksi sebelumnya ...' })).toBe(HOLD_SHIFT_MESSAGE)
    expect(HOLD_SHIFT_MESSAGE).toBe('Tutup/Buka shift menunggu transaksi sebelumnya tersinkron')
  })
  it('keeps the generic message for a shift op that is stuck for another reason', () => {
    expect(stuckMessage({ type: 'shift_close', lastError: 'timeout' })).toBe(STUCK_RETRY_MESSAGE)
  })
})
