import type { InputHTMLAttributes } from 'react'
import { useCashField } from './cashInput'

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onPaste' | 'type' | 'inputMode' | 'ref'> & {
  /** Raw digit string ("1000000"), '' = empty. The same shape the Bayar field keeps (see cashInput.ts). */
  raw: string
  onRawChange: (raw: string) => void
}

/**
 * A money field that shows "Rp 1.000.000" while the state keeps plain digits. All parsing, paste and caret handling
 * is `useCashField` from cashInput.ts (the Bayar field's parser); this only wraps it so a list of fields can each use it.
 */
export function CashAmountInput({ raw, onRawChange, ...rest }: Props) {
  const field = useCashField(raw, onRawChange)
  return <input type="text" inputMode="numeric" autoComplete="off" {...rest} {...field} />
}
