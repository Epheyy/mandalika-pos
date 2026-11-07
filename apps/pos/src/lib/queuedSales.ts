import type { LocalReceipt } from '@mandalika/sync'
import { SPLIT_LABEL, paymentLabel } from './paymentLabels'

/** A payment method for display where the configured labels are not at hand: the built-in name, else the id made
 *  readable ("go_pay" -> "Go Pay"; Backoffice ids are the lower-cased name with underscores). */
export function methodDisplayLabel(code: string): string {
  const known = paymentLabel(code)
  if (known !== code) return known
  return code.split(/[_-]/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || code
}

/** One sale still waiting in the outbox, in the shape the Koneksi sheet lists (W5-03). Display only. */
export interface QueuedSale {
  key: string
  number: string
  methodLabel: string
  total: number | null
  capturedAt: string
}

/** The sales still queued on this tablet, oldest first (by when each sale was captured). Reads the engine's own
 *  receipt view (`localReceipts()`); parked sales are NOT here, they already show under "Perlu ditinjau". */
export function queuedSalesFrom(receipts: readonly LocalReceipt[]): QueuedSale[] {
  return receipts
    .filter((r) => r.state === 'queued')
    .map((r) => ({
      key: r.idempotencyKey,
      number: r.orderNumber,
      methodLabel: r.tenders && new Set(r.tenders.map((t) => t.method)).size > 1 ? SPLIT_LABEL : methodDisplayLabel(r.paymentMethod),
      total: r.quotedTotal,
      capturedAt: r.capturedAt,
    }))
    .sort((a, b) => (Date.parse(a.capturedAt) || 0) - (Date.parse(b.capturedAt) || 0))
}

/** "14:05" for today, "07 Nov 14:05" for an earlier day; '' when unreadable. */
export function queuedTimeText(iso: string, now: number): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const time = d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false }).replace('.', ':')
  return d.toDateString() === new Date(now).toDateString() ? time : `${d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' })} ${time}`
}
