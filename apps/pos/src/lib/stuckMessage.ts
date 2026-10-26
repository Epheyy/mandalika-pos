export const STUCK_RETRY_MESSAGE =
  'Belum terkirim setelah beberapa kali coba. Transaksi aman di tablet. Jika terus begini, hubungi admin.'

export const HOLD_SHIFT_MESSAGE = 'Tutup/Buka shift menunggu transaksi sebelumnya tersinkron'

/** What the cashier reads for an item that keeps retrying. A shift open/close the server HELD (its
 *  message says "ditunda") is waiting on earlier transactions, not on a broken server. */
export function stuckMessage(item: { type: string; lastError?: string }): string {
  const held = (item.type === 'shift_close' || item.type === 'shift_open') && /ditunda/i.test(item.lastError ?? '')
  return held ? HOLD_SHIFT_MESSAGE : STUCK_RETRY_MESSAGE
}
