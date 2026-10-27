const MAX_DIGITS = 12

/** Applies a keypad key to the typed cash amount: digits append (no leading zeros, at most 12 digits),
 *  '⌫' drops one digit. */
export function applyKey(current: string, key: string): string {
  if (key === '⌫') return current.slice(0, -1)
  const next = (current + key).replace(/^0+/, '')
  return next.length > MAX_DIGITS ? current : next
}
