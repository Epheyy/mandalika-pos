/**
 * Field rules for the QA wave E inputs (2026-11-08). Each returns an Indonesian message to show next to the
 * field, or null when the value is fine. The server enforces the same bounds (backend/internal/write), so a
 * stale form cannot save what the form itself would refuse.
 */

export const MAX_POINTS_PER_THOUSAND = 1000
export const MAX_REDEMPTION_RATE = 100000
export const MIN_RECEIPT_COPIES = 1
export const MAX_RECEIPT_COPIES = 5

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function pointsPerThousandError(v: number | undefined): string | null {
  if (!isNum(v) || v <= 0) return 'Isi angka lebih dari 0.'
  if (v > MAX_POINTS_PER_THOUSAND) return `Paling banyak ${MAX_POINTS_PER_THOUSAND} poin.`
  return null
}

export function redemptionRateError(v: number | undefined): string | null {
  if (!isNum(v) || v <= 0) return 'Isi angka lebih dari 0.'
  if (v > MAX_REDEMPTION_RATE) return `Paling banyak ${MAX_REDEMPTION_RATE.toLocaleString('id-ID')} poin.`
  return null
}

/** Receipt copies: a whole number 1-5; undefined keeps the default of 1. */
export function receiptCopiesError(v: number | null | undefined): string | null {
  if (v === undefined || v === null) return null
  if (!isNum(v) || !Number.isInteger(v) || v < MIN_RECEIPT_COPIES || v > MAX_RECEIPT_COPIES) {
    return `Isi bilangan bulat ${MIN_RECEIPT_COPIES}-${MAX_RECEIPT_COPIES}.`
  }
  return null
}

/** Goods-in quantity text: empty is "no line"; anything else must be a whole number above 0. */
export function wholeQtyError(text: string): string | null {
  const t = text.trim()
  if (t === '') return null
  const n = Number(t)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return 'Jumlah harus bilangan bulat.'
  if (n <= 0) return 'Jumlah harus lebih dari 0.'
  return null
}

/** Goods-in unit cost text: optional; zero is allowed, negative or non-numeric is not. */
export function unitCostError(text: string): string | null {
  const t = text.trim()
  if (t === '') return null
  const n = Number(t)
  if (!Number.isFinite(n)) return 'Harga beli harus berupa angka.'
  if (n < 0) return 'Harga beli tidak boleh negatif.'
  return null
}
