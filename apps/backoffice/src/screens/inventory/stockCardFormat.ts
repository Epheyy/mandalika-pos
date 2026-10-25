import { localDay } from '../../lib/businessDay'

export const MOVEMENT_KINDS = [
  'sale', 'refund', 'transfer_out', 'transfer_in', 'transfer_cancel', 'receipt', 'adjust', 'count', 'opening', 'write_off',
] as const

export type MovementKind = (typeof MOVEMENT_KINDS)[number]

export const MOVEMENT_KIND_LABEL: Record<MovementKind, string> = {
  sale: 'Penjualan',
  refund: 'Refund',
  transfer_out: 'Transfer Keluar',
  transfer_in: 'Transfer Masuk',
  transfer_cancel: 'Batal Transfer',
  receipt: 'Penerimaan',
  adjust: 'Penyesuaian',
  count: 'Opname',
  opening: 'Saldo Awal',
  write_off: 'Penghapusan',
}

/** An instant as `dd/mm/yyyy HH.mm` in the location's timezone. */
export function formatMovementTime(iso: string, zone: string): string {
  return new Date(iso).toLocaleString('id-ID', {
    timeZone: zone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** A day as YYYY-MM-DD in the location timezone. */
function dayInZone(iso: string, zone: string): string {
  return new Date(iso).toLocaleDateString('sv-SE', { timeZone: zone })
}

/** Recorded on a later business day than it occurred (an offline sale synced days later). */
export function isRecordedLate(occurredAt: string, recordedAt: string, zone: string): boolean {
  return dayInZone(occurredAt, zone) < dayInZone(recordedAt, zone)
}

export function daysAgoDay(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return localDay(d)
}
