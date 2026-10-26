import type { ButtonHTMLAttributes, ReactNode } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'promo' | 'reward'
export type ButtonSize = 'md' | 'lg'

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  leading?: ReactNode
  fullWidth?: boolean
  children?: ReactNode
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-on-brand active:bg-brand-pressed',
  secondary: 'bg-white border border-paper-2 text-ink-900 active:bg-paper-1',
  ghost: 'bg-transparent text-ink-700 active:bg-paper-1',
  danger: 'bg-danger text-white active:opacity-90',
  promo: 'bg-promo-bg text-promo active:opacity-90',
  reward: 'bg-reward-bg text-reward active:opacity-90',
}

const SIZE_CLASSES: Record<ButtonSize, string> = {
  md: 'min-h-12 px-4 text-sm',
  lg: 'min-h-16 px-6 text-base',
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  leading,
  fullWidth = false,
  className = '',
  type = 'button',
  children,
  ...rest
}: Props) {
  const classes = [
    'inline-flex items-center justify-center gap-2 rounded-control font-semibold tnum',
    'disabled:opacity-50 disabled:pointer-events-none',
    VARIANT_CLASSES[variant],
    SIZE_CLASSES[size],
    fullWidth ? 'w-full' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <button {...rest} type={type} disabled={disabled || loading} aria-busy={loading || undefined} className={classes}>
      {loading ? (
        <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
      ) : (
        leading
      )}
      {children}
    </button>
  )
}
