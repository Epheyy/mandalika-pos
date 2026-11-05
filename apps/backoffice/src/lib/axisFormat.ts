const oneDecimal = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 1 })

/** Compact rupiah for chart axes: "Rp 18 jt", "Rp 500 rb", "Rp 750". Negative values keep their sign. */
export function compactRupiah(v: number): string {
  const abs = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  if (abs >= 1_000_000_000) return `${sign}Rp ${oneDecimal.format(abs / 1_000_000_000)} M`
  if (abs >= 1_000_000) return `${sign}Rp ${oneDecimal.format(abs / 1_000_000)} jt`
  if (abs >= 1_000) return `${sign}Rp ${oneDecimal.format(abs / 1_000)} rb`
  return `${sign}Rp ${oneDecimal.format(abs)}`
}

/** True when every value is 0 (or the list is empty): the axis would only show a column of "Rp 0". */
export const isAllZero = (values: readonly number[]): boolean => values.every((v) => v === 0)
