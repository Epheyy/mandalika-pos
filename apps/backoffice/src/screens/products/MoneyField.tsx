import { useMoneyField } from '../../lib/moneyInput'
import { fieldClass } from '../../ui/Field'
import { cn } from '../../ui/cn'

interface MoneyFieldProps {
  id?: string
  /** The raw digit string ("1000000"), or "" for no amount. */
  raw: string
  onRawChange: (raw: string) => void
  label: string
  placeholder?: string
  disabled?: boolean
  invalid?: boolean
  className?: string
}

/** A price box that reads "Rp 1.000.000" while the editor keeps only the raw digits (BO2-07). */
export function MoneyField({ id, raw, onRawChange, label, placeholder, disabled, invalid, className }: MoneyFieldProps) {
  const field = useMoneyField(raw, onRawChange)
  return (
    <input
      {...field}
      id={id}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      placeholder={placeholder}
      disabled={disabled}
      aria-label={label}
      aria-invalid={invalid ? true : undefined}
      className={cn(fieldClass, className)}
    />
  )
}
