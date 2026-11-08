import type { Tone } from '../components/ui/tone'

export type ChipInput = {
  reachable: boolean
  offlineLevel: 'unknown' | 'ok' | 'warn' | 'locked'
  offlineHours?: number
  /** Items waiting in the outbox (sending or queued). */
  pending: number
  /** Retryable items that keep failing. */
  stuck: number
  /** Dead-lettered items needing review. */
  parked: number
  accountIssue: boolean
  /** A reference-data pull is in flight. */
  updating: boolean
  /** Backoffice has newer reference data than this tablet. */
  wallRaised: boolean
  /** Stock drift (another tablet, a refund) is known but not pulled yet (F19). Absent = nothing pending. */
  stockPending?: boolean
}

export type ChipModel = { text: string; tone: Tone }

const ACCOUNT_CHIP: ChipModel = { text: 'Masalah akun', tone: 'danger' }

/** The one connection + queue chip (UX direction section 3.5). Pure: the caller maps engine state. */
export function chipModel(i: ChipInput): ChipModel {
  return i.reachable ? onlineChip(i) : offlineChip(i)
}

function onlineChip(i: ChipInput): ChipModel {
  if (i.parked > 0) return { text: `${i.parked} perlu ditinjau`, tone: 'danger' }
  if (i.accountIssue) return ACCOUNT_CHIP
  // The lock lifts only after contact, so a green chip beside the lock banner would be wrong.
  if (i.offlineLevel === 'locked') return { text: 'Terkunci · hubungi admin', tone: 'danger' }
  if (i.stuck > 0) return { text: `${i.stuck} tertunda`, tone: 'warn' }
  if (i.pending > 0) return { text: `Mengirim ${i.pending}…`, tone: 'info' }
  if (i.updating) return { text: 'Memperbarui data…', tone: 'info' }
  if (i.wallRaised) return { text: 'Data baru siap · perbarui', tone: 'info' }
  // The queue is sent but the stock snapshot lags: do not claim everything is fresh.
  if (i.stockPending) return { text: 'Stok menunggu diperbarui', tone: 'info' }
  return { text: 'Online · Tersinkron', tone: 'ok' }
}

function offlineChip(i: ChipInput): ChipModel {
  if (i.accountIssue) return ACCOUNT_CHIP
  const locked = i.offlineLevel === 'locked'
  const prefix = locked ? 'Offline terkunci' : i.offlineLevel === 'warn' ? `Offline ${i.offlineHours ?? 10} jam` : 'Offline'
  if (i.parked > 0) return { text: `${prefix} · ${i.parked} perlu ditinjau`, tone: 'danger' }
  const tone: Tone = locked ? 'danger' : 'warn'
  if (i.pending > 0) {
    return { text: `${prefix} · ${i.pending} tersimpan`, tone }
  }
  return { text: `${prefix} · ${locked ? 'hubungi admin' : 'aman'}`, tone }
}
