import { useLayoutEffect, useRef, type ChangeEvent, type ClipboardEvent, type RefObject } from 'react'

/**
 * Money entry for the backoffice price fields (BO2-07): shown as "Rp 1.000.000" while typing, kept as the raw
 * digit string ("1000000"). The same algorithm as the POS money field (apps/pos/src/cashier/cashInput.ts), so a
 * price keyed the same way saves byte-identical to before: the editor only ever sees the raw digits, never the
 * formatting. Empty stays empty (a variant price saves as 0, an outlet price as "use the base price").
 */

/** Same limit as the POS money field: 12 digits. */
export const MAX_MONEY_DIGITS = 12

const RUPIAH_PREFIX = 'Rp '
const GROUPING = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 })

function digitsToRaw(digits: string): string | null {
  if (digits === '') return ''
  const trimmed = digits.replace(/^0+/, '')
  if (trimmed.length > MAX_MONEY_DIGITS) return null
  return trimmed === '' ? '0' : trimmed
}

/**
 * Raw digits for text TYPED into the field: every non-digit is dropped. Deleting one character of "Rp 1.000"
 * leaves "Rp 1.00", which must read as 100, so typing never looks for a fraction.
 * Null when the amount is longer than the maximum. A typed zero stays "0" (short, as before); empty stays empty.
 */
export function parseTypedMoney(text: string): string | null {
  return digitsToRaw(text.replace(/\D/g, ''))
}

/**
 * Raw digits for text PASTED into the field ("Rp 350.000", "350 000", "IDR 1,250,000"). Like typing, but a
 * trailing fraction ("350.50", "350,5", "350.000,00") is cut off: rupiah has no cents, and reading its digits
 * as part of the amount would multiply it by 10 or 100. Null when over the maximum.
 */
export function parseMoneyInput(text: string): string | null {
  return digitsToRaw(text.replace(/[.,]\d{1,2}\s*$/, '').replace(/\D/g, ''))
}

/** The field text for the raw digit string: "Rp 350.000", or "" so the placeholder shows. */
export function formatMoneyInput(raw: string): string {
  if (raw === '') return ''
  return `${RUPIAH_PREFIX}${GROUPING.format(Number(raw))}`
}

/** What the field's onChange stores: the typed digits, or the current value when the text is over the maximum. */
export function nextMoneyInput(current: string, text: string): string {
  return parseTypedMoney(text) ?? current
}

/** What the field's onPaste stores: the pasted amount, or the current value when it is over the maximum. */
export function pastedMoneyInput(current: string, text: string): string {
  const parsed = parseMoneyInput(text)
  // Pasting text with no amount in it must not wipe an amount already entered (empty would mean no amount).
  return parsed === null || parsed === '' ? current : parsed
}

const countDigits = (text: string): number => text.replace(/\D/g, '').length

/** Caret position in the formatted text that sits right after the n-th digit (n = 0: before the first digit). */
export function caretAfterDigits(formatted: string, n: number): number {
  if (n <= 0) return Math.min(RUPIAH_PREFIX.length, formatted.length)
  let seen = 0
  for (let i = 0; i < formatted.length; i++) {
    if (/\d/.test(formatted[i]!)) seen += 1
    if (seen === n) return i + 1
  }
  return formatted.length
}

export interface MoneyFieldProps {
  ref: RefObject<HTMLInputElement | null>
  value: string
  onChange: (e: ChangeEvent<HTMLInputElement>) => void
  onPaste: (e: ClipboardEvent<HTMLInputElement>) => void
}

/**
 * Props for the formatted money <input>. Re-formatting changes the text length ("Rp 1.500.000" -> "Rp 500.000"),
 * which would throw the caret to the end and make the next keystroke land in the wrong place, so the caret is put
 * back after the same digit it was after before the edit.
 */
export function useMoneyField(raw: string, onRawChange: (raw: string) => void): MoneyFieldProps {
  const ref = useRef<HTMLInputElement>(null)
  const pendingDigits = useRef<number | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (pendingDigits.current === null || !el) return
    const pos = caretAfterDigits(formatMoneyInput(raw), pendingDigits.current)
    pendingDigits.current = null
    if (document.activeElement === el) el.setSelectionRange(pos, pos)
  })
  return {
    ref,
    value: formatMoneyInput(raw),
    onChange: (e) => {
      const el = e.target
      pendingDigits.current = countDigits(el.value.slice(0, el.selectionStart ?? el.value.length))
      onRawChange(nextMoneyInput(raw, el.value))
    },
    onPaste: (e) => {
      e.preventDefault()
      pendingDigits.current = null
      onRawChange(pastedMoneyInput(raw, e.clipboardData.getData('text')))
    },
  }
}
