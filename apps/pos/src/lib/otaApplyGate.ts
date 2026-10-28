// C5 (D-19): when may a downloaded OTA bundle be applied? Applying reloads the WebView, which destroys
// the cart, any open checkout and any in-memory write. So the "Mulai ulang sekarang" button is enabled
// only while nothing is mid-sale. Pure, so every blocking condition is unit-testable.

export interface OtaGateInput {
  cartCount: number
  isCheckoutOpen: boolean
  /** The reducer's order-commit flag. */
  isProcessing: boolean
  /** The "Pembayaran berhasil" screen (receipt printing/sharing happens there). */
  isSuccessOpen: boolean
  /** A refund dialog is open, or a refund is being written. */
  refundActive: boolean
  /** A sale/refund/customer/receive single-flight gate is busy: an outbox write is in flight. */
  writesInFlight: boolean
}

export type OtaBlockReason = 'saving' | 'checkout' | 'refund' | 'cart'

export const OTA_BLOCK_COPY: Record<OtaBlockReason, string> = {
  saving: 'Transaksi sedang disimpan. Tunggu sebentar.',
  checkout: 'Pembayaran sedang berjalan.',
  refund: 'Refund sedang berjalan.',
  cart: 'Keranjang belum kosong.',
}

/** The most urgent reason a restart must wait, or null when it is safe. */
export function otaBlockReason(f: OtaGateInput): OtaBlockReason | null {
  if (f.writesInFlight || f.isProcessing) return 'saving'
  if (f.isCheckoutOpen || f.isSuccessOpen) return 'checkout'
  if (f.refundActive) return 'refund'
  if (f.cartCount > 0) return 'cart'
  return null
}

export const otaCanApply = (f: OtaGateInput): boolean => otaBlockReason(f) === null

/** The tap-time gate: the render-derived flags (customer/shift saves are React state) plus the live single-flight refs (a sale started after the last render). */
export function otaGate(
  base: Omit<OtaGateInput, 'writesInFlight'>,
  hasStateWrite: boolean,
  gates: ReadonlyArray<{ current: { isBusy(): boolean } }>,
): OtaGateInput {
  return { ...base, writesInFlight: hasStateWrite || gates.some((g) => g.current.isBusy()) }
}
