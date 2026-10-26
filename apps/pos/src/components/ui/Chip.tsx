import type { ReactNode } from 'react'
import { toneClasses, type Tone } from './tone'

type Props = {
  selected?: boolean
  tone?: Tone
  dot?: boolean
  onClick?: () => void
  className?: string
  children?: ReactNode
}

const UNSELECTED = 'bg-white border border-paper-2 text-ink-700'

export function Chip({ selected = false, tone = 'neutral', dot = false, onClick, className = '', children }: Props) {
  const palette = selected ? toneClasses(tone === 'neutral' ? 'brand' : tone) : UNSELECTED
  const classes = `inline-flex min-h-11 items-center gap-2 rounded-chip px-4 text-sm font-semibold ${palette} ${className}`.trim()
  const content = (
    <>
      {dot && <span aria-hidden="true" className="h-2 w-2 rounded-full bg-current" />}
      {children}
    </>
  )
  if (!onClick) return <span className={classes}>{content}</span>
  return (
    <button type="button" onClick={onClick} aria-pressed={selected} className={classes}>
      {content}
    </button>
  )
}
