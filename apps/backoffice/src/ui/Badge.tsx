import type { ReactNode } from 'react'
import { cn } from './cn'

type Tone = 'gold' | 'success' | 'danger' | 'warning' | 'neutral'

const TONE: Record<Tone, string> = {
  gold: 'bg-paper-1 text-ink-700',
  success: 'bg-ok-bg text-ok',
  danger: 'bg-danger-bg text-danger',
  warning: 'bg-warn-bg text-warn-strong',
  neutral: 'bg-paper-1 text-ink-700',
}

interface BadgeProps {
  tone?: Tone
  className?: string
  children: ReactNode
}

/** Small status/role pill. Color carries meaning (semantic-only). */
export function Badge({ tone = 'neutral', className, children }: BadgeProps) {
  return (
    <span className={cn('px-2.5 py-1 text-xs font-bold rounded-lg', TONE[tone], className)}>
      {children}
    </span>
  )
}
