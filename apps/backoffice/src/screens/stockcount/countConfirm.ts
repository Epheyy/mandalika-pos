import type { StockCountItem } from '@mandalika/api'
import { signed } from '../../lib/inventoryApproval'
import type { ConfirmOptions } from '../../ui/ConfirmDialog'

type CountLine = Pick<StockCountItem, 'difference' | 'actualQty' | 'baselineQty' | 'frozenQty'>

/** Difference of one line, as the Selisih column shows it: the stored one, else counted minus baseline (frozen when no baseline yet). */
export function lineDifference(it: CountLine): number | null {
  return it.difference ?? (it.actualQty != null ? it.actualQty - (it.baselineQty ?? it.frozenQty) : null)
}

export interface CountSummary {
  /** Lines that have a counted quantity (only these change stock when the count completes). */
  counted: number
  uncounted: number
  /** Sum of the counted lines' differences, same formula as the Selisih column. */
  net: number
}

export function summarizeCount(items: readonly CountLine[]): CountSummary {
  let counted = 0
  let net = 0
  for (const it of items) {
    if (it.actualQty == null) continue
    counted += 1
    net += lineDifference(it) ?? 0
  }
  return { counted, uncounted: items.length - counted, net }
}

const units = (n: number) => `${Math.abs(n).toLocaleString('id-ID')} unit`

export function startCountConfirm(name: string): ConfirmOptions {
  return {
    title: `Mulai opname ${name}?`,
    consequence: 'Stok sistem saat ini dibekukan sebagai acuan. Stok tidak berubah sampai opname diselesaikan.',
    confirmLabel: 'Mulai opname',
  }
}

export function cancelCountConfirm(name: string, status: string): ConfirmOptions {
  return {
    title: `Batalkan opname ${name}?`,
    consequence:
      status === 'in_progress'
        ? 'Hitungan yang sudah dimasukkan dibuang. Stok tidak berubah.'
        : 'Opname dibatalkan. Stok tidak berubah.',
    confirmLabel: 'Batalkan opname',
    cancelLabel: 'Kembali',
    tone: 'danger',
  }
}

/** Completing applies the difference of every counted line to the stock as it is now. */
export function completeCountConfirm(name: string, s: CountSummary): ConfirmOptions {
  const effect =
    s.counted === 0
      ? 'Belum ada baris yang dihitung, jadi stok tidak berubah.'
      : s.net === 0
        ? `Tidak ada selisih bersih dari ${s.counted} baris yang dihitung.`
        : `Stok akan ${s.net > 0 ? 'bertambah' : 'berkurang'} ${units(s.net)} (selisih bersih ${signed(s.net)}) dari ${s.counted} baris yang dihitung, dihitung terhadap stok saat ini.`
  const rest = s.uncounted > 0 && s.counted > 0 ? ` ${s.uncounted} baris yang belum dihitung tidak diubah.` : ''
  return {
    title: `Selesaikan opname ${name}?`,
    consequence: `${effect}${rest} Penjualan selama penghitungan tetap dihitung.`,
    confirmLabel: 'Selesaikan opname',
  }
}
