import { ApiError } from '@mandalika/api'

// A08: the online step-up for a transfer receive. Pure, so the modal stays thin and the outcomes
// (offline, refused, locked with a countdown, retryable failure) are tested without a DOM.

export const OFFLINE_MESSAGE = 'Persetujuan penerimaan butuh koneksi internet.'
/** The one body the server returns for an unknown, ineligible, no-PIN or wrong-PIN approver. */
export const REFUSED_MESSAGE = 'PIN salah atau penyetuju tidak berwenang'
const UNREACHABLE_MESSAGE = 'Tidak bisa menghubungi server. Periksa koneksi lalu coba lagi.'
const OLD_SERVER_MESSAGE = 'Persetujuan penerimaan butuh koneksi internet dan server versi terbaru.'
const TRANSFER_MISSING_MESSAGE = 'Transfer tidak ditemukan. Muat ulang daftar penerimaan.'
const DEFAULT_LOCK_SECONDS = 60

export interface ReceiveGrantInput {
  idempotencyKey: string
  transferId: string
  items: { productId: string; variantSize: string; receivedQty: number }[]
  discrepancyReason?: string
  approverUserId: string
  pin: string
}

export type GrantOutcome =
  | { kind: 'offline'; message: string }
  | { kind: 'granted'; grantId: string }
  | { kind: 'refused'; message: string }
  | { kind: 'locked'; retryAfterSeconds: number; hard: boolean; message: string }
  | { kind: 'failed'; message: string }

export interface GrantDeps {
  isOnline: () => boolean
  request: (input: ReceiveGrantInput) => Promise<{ approvalGrantId: string }>
}

function lockedFrom(err: ApiError): GrantOutcome {
  const body = (err.body ?? {}) as { retryAfterSeconds?: unknown; hardLocked?: unknown }
  const hard = body.hardLocked === true
  const secs = typeof body.retryAfterSeconds === 'number' && body.retryAfterSeconds > 0
    ? Math.ceil(body.retryAfterSeconds)
    : hard ? 0 : DEFAULT_LOCK_SECONDS
  return { kind: 'locked', retryAfterSeconds: secs, hard, message: err.message }
}

/** Ask the server to verify the approver PIN and mint a grant. Never throws: every outcome is a value. */
export async function requestReceiveGrant(deps: GrantDeps, input: ReceiveGrantInput): Promise<GrantOutcome> {
  if (!deps.isOnline()) return { kind: 'offline', message: OFFLINE_MESSAGE }
  try {
    const grant = await deps.request(input)
    return { kind: 'granted', grantId: grant.approvalGrantId }
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.kind === 'network' || e.kind === 'timeout' || e.status === 0) return { kind: 'failed', message: UNREACHABLE_MESSAGE }
      if (e.status === 429) return lockedFrom(e)
      if (e.status === 403) {
        return e.message === REFUSED_MESSAGE ? { kind: 'refused', message: REFUSED_MESSAGE } : { kind: 'failed', message: e.message }
      }
      if (e.status === 404) {
        // The mint's own 404 (unknown transfer) versus a server without the route at all.
        return { kind: 'failed', message: e.message === 'transfer tidak ditemukan' ? TRANSFER_MISSING_MESSAGE : OLD_SERVER_MESSAGE }
      }
      if (e.status >= 500) return { kind: 'failed', message: UNREACHABLE_MESSAGE }
      return { kind: 'failed', message: e.message }
    }
    return { kind: 'failed', message: UNREACHABLE_MESSAGE }
  }
}

export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
