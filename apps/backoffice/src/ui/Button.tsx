import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from './cn'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md'

const VARIANT: Record<Variant, string> = {
  primary: 'bg-brand-strong text-on-brand hover:bg-brand-strong-hover disabled:opacity-50',
  secondary:
    'bg-paper-1 text-ink-900 ring-1 ring-inset ring-ink-900/10 hover:bg-paper-2 disabled:opacity-50',
  ghost: 'text-ink-700 hover:bg-paper-1 hover:text-ink-900 disabled:opacity-50',
  danger: 'bg-danger-solid text-on-brand hover:opacity-90 disabled:opacity-50',
}

const SIZE: Record<Size, string> = {
  // One height scale (plan 2.2): header actions 40, pagination and row actions 36.
  sm: 'h-9 px-3 text-xs gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  loading?: boolean
  /** Leading icon; hidden while `loading` (replaced by a spinner). */
  icon?: ReactNode
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  disabled,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button type="button"
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center font-bold rounded-xl transition-all',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-strong/50',
        'disabled:cursor-not-allowed',
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Loader2 className={cn('animate-spin', size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4')} />
      ) : (
        icon
      )}
      {children}
    </button>
  )
}
