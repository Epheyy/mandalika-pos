import type { DiscountCode, Promotion } from '@mandalika/api'
import { format, parseISO } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import { BRAND } from '../../lib/brand'
import { PROMOTION_STATUS, PROMOTION_TYPE, DISCOUNT_CODE_TYPE, labelOf } from '../../lib/labels'
import { promoStatus } from './promoStatus'

/** Human value summary per promo type (list column and export). */
export function promoValueLabel(p: Promotion): string {
  if (p.type === 'percentage') return `${p.value}%`
  if (p.type === 'fixed') return BRAND.currency.format(p.value)
  if (p.type === 'bogo') return 'Buy 1 Get 1'
  if (p.type === 'buy_x_get_y') {
    const c = p.bxgyConfig
    if (!c) return 'Beli X, Gratis/Diskon Y'
    const deal =
      c.getDiscountKind === 'percentage' && c.getDiscountValue === 100
        ? 'Gratis'
        : c.getDiscountKind === 'percentage'
          ? `Diskon ${c.getDiscountValue}%`
          : `Potongan ${BRAND.currency.format(c.getDiscountValue)}`
    return `Beli ${c.buyQuantity}, ${deal} ${c.getQuantity}`
  }
  if (p.type === 'tiered') return `${p.tieredConfig?.tiers?.length ?? 0} tingkat`
  if (p.type === 'bundle') return `Harga paket ${BRAND.currency.format(p.bundleConfig?.bundlePrice ?? 0)}`
  return String(p.value)
}

export const codeValueLabel = (c: DiscountCode): string => (c.type === 'percentage' ? `${c.value}%` : BRAND.currency.format(c.value))

/** "25–30 Nov 2026" (same month), "28 Nov – 3 Des 2026", "Mulai 25 Nov 2026", "Sampai 30 Nov 2026"; "Tanpa batas waktu" when both ends are open. */
export function periodRangeText(startDate?: string | null, endDate?: string | null): string {
  const fmt = (d: string, pattern: string) => format(parseISO(d), pattern, { locale: idLocale })
  if (!startDate && !endDate) return 'Tanpa batas waktu'
  if (startDate && !endDate) return `Mulai ${fmt(startDate, 'd MMM yyyy')}`
  if (!startDate && endDate) return `Sampai ${fmt(endDate, 'd MMM yyyy')}`
  const start = parseISO(startDate as string)
  const end = parseISO(endDate as string)
  if (fmt(startDate as string, 'yyyy-MM') === fmt(endDate as string, 'yyyy-MM')) {
    return start.getTime() === end.getTime() ? fmt(endDate as string, 'd MMM yyyy') : `${format(start, 'd')}–${fmt(endDate as string, 'd MMM yyyy')}`
  }
  const sameYear = start.getFullYear() === end.getFullYear()
  return `${fmt(startDate as string, sameYear ? 'd MMM' : 'd MMM yyyy')} – ${fmt(endDate as string, 'd MMM yyyy')}`
}

/** One meta line for a list row: how it applies · outlet scope · period. Empty outletIds = every outlet. */
export function promoMetaLine(p: Pick<Promotion, 'autoApply' | 'codeOnly' | 'outletIds' | 'startDate' | 'endDate'>): string {
  const how = p.codeOnly ? 'Hanya dengan kode' : p.autoApply ? 'Otomatis di kasir' : 'Dipilih kasir'
  const n = p.outletIds?.length ?? 0
  const scope = n === 0 ? 'Semua outlet' : `${n} outlet`
  return [how, scope, periodRangeText(p.startDate, p.endDate)].join(' · ')
}

type Dated = { isActive: boolean; startDate?: string | null; endDate?: string | null }

export function promotionExportRows(rows: readonly Promotion[], today: string) {
  return rows.map((p) => ({
    Nama: p.name,
    Jenis: labelOf(PROMOTION_TYPE, p.type).label,
    Nilai: promoValueLabel(p),
    'Min. Belanja': p.minPurchase ?? 0,
    Mulai: p.startDate ?? '',
    Selesai: p.endDate ?? '',
    Status: statusText(p, today),
    Aktif: p.isActive ? 'Ya' : 'Tidak',
    Otomatis: p.autoApply ? 'Ya' : 'Tidak',
  }))
}

export function codeExportRows(rows: readonly DiscountCode[], today: string) {
  return rows.map((c) => ({
    Kode: c.code,
    Jenis: labelOf(DISCOUNT_CODE_TYPE, c.type).label,
    Nilai: c.value,
    'Min. Belanja': c.minPurchase ?? 0,
    Kuota: c.usageLimit ?? 0,
    Terpakai: c.usageCount,
    Mulai: c.startDate ?? '',
    Selesai: c.endDate ?? '',
    Status: statusText(c, today),
    Aktif: c.isActive ? 'Ya' : 'Tidak',
  }))
}

const statusText = (row: Dated, today: string): string => labelOf(PROMOTION_STATUS, promoStatus(row, today)).label
