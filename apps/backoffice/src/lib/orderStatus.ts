/** Order status labels and badge tones shared by the order list, export, and customer history (C4a). */
export type OrderStatusTone = 'success' | 'danger' | 'warning' | 'neutral'

export function orderStatusLabel(status: string): string {
  if (status === 'completed') return 'Selesai'
  if (status === 'partially_refunded') return 'Sebagian refund'
  if (status === 'refunded') return 'Refund'
  if (status === 'cancelled') return 'Dibatalkan'
  return status
}

export function orderStatusTone(status: string): OrderStatusTone {
  if (status === 'completed') return 'success'
  if (status === 'partially_refunded') return 'warning'
  if (status === 'refunded') return 'danger'
  return 'neutral'
}

/** The admin whole-order refund only applies to a still-completed order; a part-refunded one returns 409. */
export const canRefundWholeOrder = (status: string): boolean => status === 'completed'

/** Tint of the order-row icon tile and glyph: red for refunded, amber for partially refunded. */
export function orderIconClasses(status: string): { tile: string; glyph: string } {
  if (status === 'refunded') return { tile: 'bg-red-50', glyph: 'text-red-400' }
  if (status === 'partially_refunded') return { tile: 'bg-amber-50', glyph: 'text-amber-500' }
  return { tile: 'bg-gold-50', glyph: 'text-gold-600' }
}
