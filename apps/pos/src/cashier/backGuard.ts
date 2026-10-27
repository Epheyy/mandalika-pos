/** What Android hardware Back should do on the cashier screen, topmost surface first. */
export type CashierBackLayer =
  | 'ignore-busy'
  | 'close-confirm'
  | 'close-picker'
  | 'close-success'
  | 'close-checkout'
  | 'close-adjustment'
  | 'cart-to-products'
  | 'consume'

export interface CashierBackFlags {
  /** An order is being committed (reducer isProcessing or the sale gate is busy). */
  isBusy: boolean
  /** A confirm dialog (customer change, Kosongkan) is open. */
  confirmOpen: boolean
  /** A BXGY/bundle picker is showing inside the Promo & Diskon sheet. */
  pickerOpen: boolean
  successOpen: boolean
  checkoutOpen: boolean
  /** The Promo & Diskon sheet or the Catatan modal. */
  adjustmentOpen: boolean
  cartTabActive: boolean
}

/**
 * Pure ordering of the core cashier surfaces (the loose full-screen overlays are checked by the
 * caller before this). Busy wins over everything: while an order is being enqueued, Back must not
 * close the checkout and expose the catalog mid-commit. The picker sits inside the sheet, so it
 * steps back to the sheet's list before the sheet itself closes. Back never exits the app.
 */
export function cashierBackLayer(f: CashierBackFlags): CashierBackLayer {
  if (f.isBusy) return 'ignore-busy'
  if (f.confirmOpen) return 'close-confirm'
  if (f.pickerOpen) return 'close-picker'
  if (f.successOpen) return 'close-success'
  if (f.checkoutOpen) return 'close-checkout'
  if (f.adjustmentOpen) return 'close-adjustment'
  if (f.cartTabActive) return 'cart-to-products'
  return 'consume'
}
