import type { LabelMap } from './types'

export type VoidReasonCode =
  | 'salah_metode_pembayaran' | 'salah_barang' | 'salah_promo' | 'salah_pelanggan' | 'transaksi_ganda' | 'transaksi_tes' | 'lainnya'

/** Reason codes in the order the server and the POS list them (a copy of apps/pos/src/cashier/void/voidRules.ts). */
export const VOID_REASONS: readonly { code: VoidReasonCode; label: string }[] = [
  { code: 'salah_metode_pembayaran', label: 'Salah metode pembayaran' },
  { code: 'salah_barang', label: 'Salah barang' },
  { code: 'salah_promo', label: 'Salah promo' },
  { code: 'salah_pelanggan', label: 'Salah pelanggan' },
  { code: 'transaksi_ganda', label: 'Transaksi ganda' },
  { code: 'transaksi_tes', label: 'Transaksi tes' },
  { code: 'lainnya', label: 'Lainnya' },
]

export const VOID_NOTE_MAX = 500
export const VOID_NOTE_MIN_LAINNYA = 10
export const VOID_NOTE_REQUIRED = 'Catatan wajib diisi minimal 10 karakter untuk alasan Lainnya.'

/** Label for a void reason code; an unknown code reads "Lainnya" (never leaks raw). */
export function voidReasonLabel(code: string | null | undefined): string {
  return VOID_REASONS.find((r) => r.code === code)?.label ?? 'Lainnya'
}

/** What a void did to its sale, by server mode (none | replace | later). */
export const VOID_MODE = {
  none: { label: 'Batalkan saja', tone: 'neutral' },
  replace: { label: 'Batalkan & perbaiki', tone: 'info' },
  later: { label: 'Batalkan, pengganti dibuat di POS', tone: 'warn' },
} as const satisfies LabelMap<string>

export const voidModeLabel = (mode: string | null | undefined): string =>
  mode && Object.prototype.hasOwnProperty.call(VOID_MODE, mode) ? VOID_MODE[mode as keyof typeof VOID_MODE].label : '—'
