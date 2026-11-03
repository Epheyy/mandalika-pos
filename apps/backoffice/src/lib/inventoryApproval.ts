import { ApiError, type InventoryReasonCode, type StockCountItem, type StockCountSubmitInput } from '@mandalika/api'

import { badgeTone, type BadgeToneName } from './labels/badgeTone'
import { OPNAME_STATUS } from './labels/opname'
import { REASON_CODE } from './labels/reason'
import { labelOf } from './labels/types'

/** Reason codes in display order, with the Indonesian label shown in selects and detail views. */
export const REASON_OPTIONS: ReadonlyArray<{ code: InventoryReasonCode; label: string }> = (
  Object.keys(REASON_CODE) as InventoryReasonCode[]
).map((code) => ({ code, label: REASON_CODE[code].label }))

export function reasonLabel(code: string | undefined | null): string {
  return code != null && Object.prototype.hasOwnProperty.call(REASON_CODE, code) ? REASON_CODE[code as InventoryReasonCode].label : (code ?? '-')
}

/** Free text is mandatory only for "Lainnya". */
export function reasonTextRequired(code: InventoryReasonCode | ''): boolean {
  return code === 'other'
}

/** Reason text sent to the direct (non-approval) adjust call: label, plus the typed text when there is any. */
export function composeReason(code: InventoryReasonCode, text: string): string {
  const t = text.trim()
  const label = reasonLabel(code)
  return t ? `${label}: ${t}` : label
}

/** Validates the reason pair; returns an Indonesian message or null when fine. */
export function validateReason(code: InventoryReasonCode | '', text: string): string | null {
  if (!code) return 'Pilih alasan.'
  if (reasonTextRequired(code) && !text.trim()) return 'Keterangan wajib diisi untuk alasan Lainnya.'
  return null
}

export function countStatusLabel(s: string): string {
  return Object.prototype.hasOwnProperty.call(OPNAME_STATUS, s) ? labelOf(OPNAME_STATUS, s).label : OPNAME_STATUS.cancelled.label
}

export type CountStatusTone = BadgeToneName

export function countStatusTone(s: string): CountStatusTone {
  return badgeTone(labelOf(OPNAME_STATUS, s).tone)
}

/** Quantity change an approval will apply: requested new qty minus what the requester saw. */
export function adjustmentDelta(qtyAtRequest: number, requestedNewQty: number): number {
  return requestedNewQty - qtyAtRequest
}

/** How far live stock moved since the request was made (0 when live is unknown). */
export function adjustmentDrift(qtyAtRequest: number, liveQty: number | undefined): number {
  return liveQty === undefined ? 0 : liveQty - qtyAtRequest
}

export function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n)
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID()
}

/** True for the 409 the server answers when direct adjust/complete is blocked by the approval flag. */
export function isApprovalRequired(e: unknown): boolean {
  if (!(e instanceof ApiError) || e.status !== 409) return false
  const body = e.body as { data?: { code?: string } } | undefined
  return body?.data?.code === 'approval_required'
}

interface LockBody {
  retryAfterSeconds?: number
  hardLocked?: boolean
  data?: { retryAfterSeconds?: number; hardLocked?: boolean }
}

function formatWait(seconds: number): string {
  if (seconds >= 3600) return `${Math.ceil(seconds / 3600)} jam`
  if (seconds >= 60) return `${Math.ceil(seconds / 60)} menit`
  return `${Math.max(1, Math.ceil(seconds))} detik`
}

/** Indonesian message for a failed approve call (wrong PIN / lock / conflict / other). */
export function approveErrorMessage(e: unknown): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : 'Gagal menyetujui.'
  if (e.status === 403) return 'PIN salah atau penyetuju tidak berwenang.'
  if (e.status === 429) {
    const b = (e.body ?? {}) as LockBody
    const wait = b.retryAfterSeconds ?? b.data?.retryAfterSeconds
    const hard = b.hardLocked ?? b.data?.hardLocked
    if (hard) return 'PIN terkunci. Hubungi admin untuk membuka kunci.'
    return wait ? `Terlalu banyak percobaan. Coba lagi dalam ${formatWait(wait)}.` : 'Terlalu banyak percobaan. Coba lagi nanti.'
  }
  return e.message
}

/** Approve PIN is 4 to 8 digits. */
export function isValidPin(pin: string): boolean {
  return /^\d{4,8}$/.test(pin)
}

export interface VarianceLine {
  item: StockCountItem
  diff: number
}

export interface LineReason {
  code: InventoryReasonCode | ''
  text: string
}

export const lineKey = (i: StockCountItem): string => `${i.productId}|${i.variantSize}`

/** Counted minus baseline (frozen qty when none); null while the line is uncounted. */
export function lineDiff(i: StockCountItem): number | null {
  if (i.difference != null) return i.difference
  return i.actualQty != null ? i.actualQty - (i.baselineQty ?? i.frozenQty) : null
}

/** Lines of a count that differ from their baseline. */
export function varianceLines(items: StockCountItem[]): VarianceLine[] {
  return items.flatMap((item) => {
    const diff = lineDiff(item)
    return diff != null && diff !== 0 ? [{ item, diff }] : []
  })
}

/** Builds the per-line payload, keeping only lines that got a reason code. */
export function buildSubmitLines(lines: VarianceLine[], reasons: Record<string, LineReason>): StockCountSubmitInput['lines'] {
  return lines.flatMap(({ item }) => {
    const r = reasons[lineKey(item)]
    if (!r || !r.code) return []
    return [{ productId: item.productId, variantSize: item.variantSize, reasonCode: r.code, reasonText: r.text.trim() || undefined }]
  })
}

export interface CountDetailRow {
  item: StockCountItem
  /** What the count is measured against: the line's baseline, or the frozen qty when it has none. */
  reference: number
  diff: number
}

/**
 * Rows of the approval detail table. `difference` stays null on the server until the count is
 * applied, so a pending count is measured here, exactly as applyCountDeltas will measure it.
 */
export function countDetailRows(items: StockCountItem[]): CountDetailRow[] {
  return varianceLines(items).map(({ item, diff }) => ({ item, diff, reference: item.baselineQty ?? item.frozenQty }))
}

/** Stock the location would hold after the delta is applied to live stock; null when live is unknown. */
export function adjustmentResultQty(liveQty: number | undefined, delta: number): number | null {
  return liveQty === undefined ? null : liveQty + delta
}
