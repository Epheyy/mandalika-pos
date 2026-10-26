import { formatRupiah } from '../../cashier/pricing'

type Props = {
  amount: number
  /** Prefix negatives with a true minus sign (U+2212) instead of the formatter's hyphen. */
  signed?: boolean
  className?: string
}

export function Money({ amount, signed = false, className = '' }: Props) {
  const text = signed && amount < 0 ? `\u2212 ${formatRupiah(Math.abs(amount))}` : formatRupiah(amount)
  return <span className={`tnum ${className}`.trim()}>{text}</span>
}
