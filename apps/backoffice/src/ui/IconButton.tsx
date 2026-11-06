import type { ButtonHTMLAttributes } from 'react'
import { cn } from './cn'

type Tone = 'default' | 'danger'

const TONE: Record<Tone, string> = {
  default: 'hover:bg-paper-1 hover:text-ink-900',
  danger: 'hover:bg-danger-bg hover:text-danger',
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: Tone
  /** Accessible name, also shown as the tooltip. Optional for now so older call sites still compile; slice Z makes it required. */
  label?: string
}

/** Square ghost action (edit / delete) — consistent row affordance. */
export function IconButton({ tone = 'default', label, className, children, ...rest }: IconButtonProps) {
  return (
    <button type="button"
      aria-label={label}
      title={label}
      className={cn(
        // 36 px touch target (plan 2.2).
        'inline-flex h-9 w-9 items-center justify-center rounded-xl text-ink-500 transition-colors flex-shrink-0',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-strong/50',
        TONE[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}
