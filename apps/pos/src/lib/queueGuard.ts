/** C2 (P13): the live queue counts and the reason shown above Tutup Shift, Lepas terminal and in the Koneksi sheet. Pure. */
import type { Tone } from '../components/ui/tone'

export type QueueCounts = { pending: number; parked: number; parkedUnstamped: number }

/** "N transaksi tersimpan di tablet, M perlu ditinjau" (zero parts dropped). */
export function queueCountsLine(c: Pick<QueueCounts, 'pending' | 'parked'>): { text: string; tone: Tone } {
  const parts: string[] = []
  if (c.pending > 0) parts.push(`${c.pending} transaksi tersimpan di tablet`)
  if (c.parked > 0) parts.push(`${c.parked} perlu ditinjau`)
  if (parts.length === 0) return { text: 'Semua transaksi sudah terkirim', tone: 'ok' }
  return { text: parts.join(', '), tone: c.parked > 0 ? 'danger' : 'warn' }
}

/** Why a guarded button is disabled, in the order the cashier can act on it. Null when nothing in the queue blocks it. */
export function queueBlockReason(c: QueueCounts, o: { needsOnline?: boolean; online?: boolean } = {}): string | null {
  if (c.parkedUnstamped > 0) return 'Hubungi admin untuk yang perlu ditinjau'
  if (c.pending > 0) return 'Tunggu sampai terkirim'
  if (o.needsOnline && o.online === false) return 'Butuh internet'
  return null
}
