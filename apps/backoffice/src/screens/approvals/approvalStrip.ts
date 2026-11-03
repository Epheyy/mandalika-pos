import { adjustmentDelta, adjustmentDrift, adjustmentResultQty, signed } from '../../lib/inventoryApproval'

export interface StripCell {
  title: 'Saat diajukan' | 'Sekarang' | 'Yang diterapkan'
  /** The headline number. */
  value: string
  /** One line under it. */
  note: string
}

export interface AdjustmentStrip {
  cells: readonly [StripCell, StripCell, StripCell]
  /** Live stock is known and the applied difference would take it below zero. */
  goesNegative: boolean
  /** Resulting stock when it goes negative (for the warning text). */
  resultingQty: number | null
  /** Live stock moved since the request, so the applied difference is not "new minus live". */
  drifted: boolean
  drift: number
  delta: number
}

interface StripInput {
  qtyAtRequest: number
  requestedNewQty: number
  liveQty?: number
}

/**
 * The three columns of an adjustment approval. The server applies the requested difference to live stock
 * (not the requested new quantity), so the third column is the difference and the stock it leads to.
 */
export function adjustmentStrip(r: StripInput): AdjustmentStrip {
  const delta = adjustmentDelta(r.qtyAtRequest, r.requestedNewQty)
  const drift = adjustmentDrift(r.qtyAtRequest, r.liveQty)
  const resulting = adjustmentResultQty(r.liveQty, delta)
  return {
    cells: [
      { title: 'Saat diajukan', value: String(r.qtyAtRequest), note: `diminta menjadi ${r.requestedNewQty}` },
      {
        title: 'Sekarang',
        value: r.liveQty === undefined ? '-' : String(r.liveQty),
        note: r.liveQty === undefined ? 'stok sekarang tidak diketahui' : drift === 0 ? 'tidak berubah sejak diajukan' : `${signed(drift)} sejak diajukan`,
      },
      {
        title: 'Yang diterapkan',
        value: signed(delta),
        note: resulting === null ? 'stok akhir tidak diketahui' : `stok menjadi ${resulting}`,
      },
    ],
    goesNegative: resulting !== null && resulting < 0,
    resultingQty: resulting,
    drifted: drift !== 0,
    drift,
    delta,
  }
}
