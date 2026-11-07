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
  /** A coloured dot before the word, for status pills (KIT-05). Role/count badges leave it off. */
  dot?: boolean
  children: ReactNode
}

/** Small status/role pill. Color carries meaning (semantic-only). */
export function Badge({ tone = 'neutral', className, dot = false, children }: BadgeProps) {
  return (
    <span className={cn(dot ? 'inline-flex items-center gap-1.5' : '', 'px-2.5 py-1 text-xs font-bold rounded-lg', TONE[tone], className)}>
      {dot && <span aria-hidden="true" className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-current" />}
      {children}
    </span>
  )
}
