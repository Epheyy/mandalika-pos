import type { ReactNode } from 'react'
import { cn } from './cn'

type Tone = 'gold' | 'success' | 'danger' | 'warning' | 'neutral'

const TONE: Record<Tone, string> = {
  gold: 'bg-gold-50 text-gold-700',
  success: 'bg-green-50 text-green-700',
  danger: 'bg-red-50 text-red-700',
  warning: 'bg-amber-50 text-amber-700',
  neutral: 'bg-gray-100 text-gray-600',
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
