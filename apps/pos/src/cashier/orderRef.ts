// Customer-facing order id shown on the success screen and printed receipt.
// Offline the canonical server number (MND-NNNNNN, global sequence) is not yet
// known, so derive a stable 6-digit code from the order uuid. Same format as
// the server's so the printed copy looks consistent; the backoffice/history
// keeps the authoritative server number.
export function localOrderRef(orderUuid: string): string {
  let h = 0
  for (const ch of orderUuid.replace(/-/g, '')) {
    h = (h * 31 + parseInt(ch, 16) || 0) % 1_000_000
  }
  return `MND-${String(Math.abs(h)).padStart(6, '0')}`
}
