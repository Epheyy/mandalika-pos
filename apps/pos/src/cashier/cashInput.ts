/**
 * The cash amount field of Bayar (D-113): shown as "Rp 350.000" while typing, kept in cashier state as the raw
 * digit string the keypad already produces ("350000"). Only the field's text is formatted; the state, the tender
 * maths and the payment payload never see the formatting, so the same amount gives the same sale as before.
 * Empty stays "exact total" (see tender.ts).
 */

/** Same limit as the keypad (lib/cashKeypad.ts): 12 digits. */
export const MAX_CASH_DIGITS = 12

const RUPIAH_PREFIX = 'Rp '
const GROUPING = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 })

function digitsToRaw(digits: string): string | null {
  if (digits === '') return ''
  const trimmed = digits.replace(/^0+/, '')
  if (trimmed.length > MAX_CASH_DIGITS) return null
  return trimmed === '' ? '0' : trimmed
}

/**
 * Raw digits for text TYPED into the field: every non-digit is dropped. Deleting one character of "Rp 1.000"
 * leaves "Rp 1.00", which must read as 100, so typing never looks for a fraction.
 * Null when the amount is longer than the maximum. A typed zero stays "0" (short, as before); empty stays empty.
 */
export function parseTypedCash(text: string): string | null {
  return digitsToRaw(text.replace(/\D/g, ''))
}

/**
 * Raw digits for text PASTED into the field ("Rp 350.000", "350 000", "IDR 1,250,000"). Like typing, but a
 * trailing fraction ("350.50", "350,5", "350.000,00") is cut off: rupiah has no cents, and reading its digits
 * as part of the amount would multiply it by 10 or 100. Null when over the maximum.
 */
export function parseCashInput(text: string): string | null {
  return digitsToRaw(text.replace(/[.,]\d{1,2}\s*$/, '').replace(/\D/g, ''))
}

/** The field text for the raw digit string: "Rp 350.000", or "" so the exact-total placeholder shows. */
export function formatCashInput(raw: string): string {
  if (raw === '') return ''
  return `${RUPIAH_PREFIX}${GROUPING.format(Number(raw))}`
}

/** What the field's onChange stores: the typed digits, or the current value when the text is over the maximum. */
export function nextCashInput(current: string, text: string): string {
  return parseTypedCash(text) ?? current
}

/** What the field's onPaste stores: the pasted amount, or the current value when it is over the maximum. */
export function pastedCashInput(current: string, text: string): string {
  return parseCashInput(text) ?? current
}
