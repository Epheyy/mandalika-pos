import type { components } from '@mandalika/api'
import type { KV, PendingShiftOp } from '@mandalika/sync'

type Shift = components['schemas']['Shift']

// Pure helpers behind useShift (A04): the header must never offer a second "Buka Shift"
// just because the last fetch failed, and an offline open/close must be visible at once.

export const OFFLINE_OPEN_MESSAGE =
  'Buka Shift butuh koneksi internet. Sambungkan internet lalu coba lagi. Setelah shift terbuka, penjualan tetap bisa dicatat saat offline.'
export const PENDING_CLOSE_MESSAGE =
  'Shift baru belum tersinkron ke server. Tunggu hingga online lalu coba tutup lagi.'

export const shiftCacheKey = (outletId: string): string => `mandalika.pos.shift.${outletId}`

/** Last shift the server told us about for this outlet (null = it said "none"/nothing cached). */
export function readShiftCache(kv: KV, outletId: string | null): Shift | null {
  if (!outletId) return null
  const raw = kv.get(shiftCacheKey(outletId))
  if (!raw) return null
  try {
    const s = JSON.parse(raw) as Shift | null
    return s && typeof s === 'object' && typeof s.id === 'string' && s.id !== '' && s.status !== 'closed' ? s : null
  } catch {
    return null
  }
}

export function writeShiftCache(kv: KV, outletId: string | null, shift: Shift | null): void {
  if (!outletId) return
  if (shift && shift.status !== 'closed') kv.set(shiftCacheKey(outletId), JSON.stringify(shift))
  else kv.remove(shiftCacheKey(outletId))
}

/** A synthesized shift stands for an open that has not reached the server yet; it has no id. */
export const isPendingOpen = (s: Shift | null): boolean => s !== null && s.id === ''

export interface OverlayContext {
  outletId: string
  cashierId: string
  cashierName: string
}

/** The shift to show: the last known server shift with the still-unacknowledged opens and
 *  closes applied in order. Parked (review) operations are not applied: they will not be sent. */
export function overlayShift(server: Shift | null, ops: readonly PendingShiftOp[], ctx: OverlayContext): Shift | null {
  let shift = server
  for (const op of ops) {
    if (op.parked) continue
    if (op.type === 'shift_open') {
      if (shift) continue // the server already has one open: this open will be refused, not doubled
      const cash = typeof op.payload.startingCash === 'number' && Number.isFinite(op.payload.startingCash) ? op.payload.startingCash : 0
      shift = {
        id: '',
        outletId: ctx.outletId,
        outletName: typeof op.payload.outletName === 'string' ? op.payload.outletName : null,
        cashierId: ctx.cashierId,
        cashierName: ctx.cashierName,
        status: 'open',
        openedAt: op.clientCreatedAt,
        startingCash: cash,
        totalSales: 0, totalOrders: 0, totalRefunds: 0, cashSales: 0, cardSales: 0, transferSales: 0, qrisSales: 0,
      }
    } else if (shift && (shift.id === '' || op.payload.shiftId === shift.id)) {
      shift = null
    }
  }
  return shift
}

/** Changes whenever the set of unacknowledged shift operations changes (a shift ack removes one). */
export const opsSignature = (ops: readonly PendingShiftOp[]): string =>
  ops.map((o) => `${o.idempotencyKey}:${o.parked ? 'p' : 'q'}`).join('|')

export interface AutoOpenInput {
  /** The outlet enables app_settings.autoOpenShift. */
  enabled: boolean
  /** A shift fetch SUCCEEDED in this session. After an offline start the header only has a
   *  guess, and auto-opening on a guess is how a second shift got opened (A04). */
  fetchedThisSession: boolean
  /** A shift (server, cached or pending open) is already showing. */
  hasShift: boolean
  isOpening: boolean
  alreadyTried: boolean
  online: boolean
}

export function shouldAutoOpen(i: AutoOpenInput): boolean {
  return i.enabled && i.fetchedThisSession && i.online && !i.hasShift && !i.isOpening && !i.alreadyTried
}
