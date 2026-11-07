import { formatRupiah } from './pricing'

const trimZero = (n: number): string => n.toFixed(1).replace('.', ',').replace(/,0$/, '')

/** A short rupiah figure for a tight stat tile: "Rp 5,9 jt", "Rp 350 rb", else the full amount. Display only. */
export function compactRupiah(amount: number): string {
  if (!Number.isFinite(amount)) return formatRupiah(0)
  const abs = Math.abs(amount)
  const sign = amount < 0 ? '-' : ''
  if (abs >= 999_950_000) return `${sign}Rp ${trimZero(abs / 1_000_000_000)} M`
  if (abs >= 999_500) return `${sign}Rp ${trimZero(abs / 1_000_000)} jt`
  if (abs >= 1_000) return `${sign}Rp ${Math.round(abs / 1_000)} rb`
  return formatRupiah(amount)
}
