import type { ButtonHTMLAttributes } from 'react'
import { cn } from './cn'

type Tone = 'default' | 'danger'

const TONE: Record<Tone, string> = {
  default: 'hover:bg-gold-50 hover:text-gold-700',
  danger: 'hover:bg-red-50 hover:text-red-600',
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: Tone
}

/** Square ghost action (edit / delete) — consistent row affordance. */
export function IconButton({ tone = 'default', className, children, ...rest }: IconButtonProps) {
  return (
    <button
      className={cn(
        'p-2 rounded-xl text-gray-400 transition-colors flex-shrink-0',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-500/40',
        TONE[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}
