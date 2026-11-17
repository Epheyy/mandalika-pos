// The receipt layout model: an ordered list of blocks plus the paper width.

import type { ReceiptRaster } from './raster'
import type { Align } from './sink'

export type PaperWidth = 58 | 80

/** Characters per line at Font A. Large text (`GS ! 0x11`) takes 2 columns per character. */
export const COLS_BY_WIDTH: Readonly<Record<PaperWidth, number>> = { 58: 32, 80: 48 }

export type TxField = 'orderNumber' | 'date' | 'cashier' | 'customerName' | 'customerPhone'

export type ReceiptBlock =
  | {
      id: string; type: 'header'; enabled: boolean; text: string; size: 'normal' | 'large'
      showOutletName: boolean; showOutletAddress: boolean; showOutletPhone: boolean; spaceAfter?: boolean
    }
  | { id: string; type: 'transaction'; enabled: boolean; fields: TxField[]; style: 'columns' | 'inline' }
  | { id: string; type: 'items'; enabled: true }
  | { id: string; type: 'totals'; enabled: true; showSubtotal: boolean; showDiscount: boolean; showTax: boolean }
  | { id: string; type: 'payment'; enabled: true; showChange?: boolean }
  | { id: string; type: 'points'; enabled: boolean }
  | {
      id: string; type: 'text'; enabled: boolean; label?: string; text: string; align: Align; bold: boolean
      size: 'normal' | 'large'; spaceBefore?: boolean
    }
  | { id: string; type: 'divider'; enabled: boolean }
  | { id: string; type: 'image'; enabled: boolean; label?: string; image: ReceiptRaster; align: Align }
  | { id: string; type: 'qr'; enabled: boolean; label?: string; url: string; align: Align }

export type ReceiptBlockType = ReceiptBlock['type']

/** `compat: 'v1'` keeps today's exact bytes (unwrapped header/footer/inline rows, Latin-1 mapping, honours
 *  `spaceAfter`, `spaceBefore` and `payment.showChange`). Only the built-in Standar layout carries it. */
export interface ReceiptLayout {
  paperWidth: PaperWidth
  blocks: ReceiptBlock[]
  compat?: 'v1'
}

/** Blocks that appear exactly once, are always enabled and keep this relative order. */
export const LOCKED_TYPES = ['items', 'totals', 'payment'] as const

export function isLockedType(t: ReceiptBlockType): boolean {
  return (LOCKED_TYPES as readonly string[]).includes(t)
}
