import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from './cn'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md'

const VARIANT: Record<Variant, string> = {
  primary: 'bg-gold-600 text-white hover:bg-gold-700 disabled:bg-gold-300',
  secondary:
    'bg-white text-gray-700 border border-gray-200 hover:bg-gray-50 hover:border-gray-300 disabled:opacity-50',
  ghost: 'text-gray-500 hover:bg-gray-100 hover:text-gray-900 disabled:opacity-50',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300',
}

const SIZE: Record<Size, string> = {
  sm: 'px-3 py-2 text-xs gap-1.5',
  md: 'px-4 py-2.5 text-sm gap-2',
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
    <button
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center font-bold rounded-xl transition-all',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-500/40',
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
