import { cn } from './cn'

interface SwitchProps {
  checked: boolean
  onChange: (next: boolean) => void
  /** Accessible name (kept identical to the old Toggle labels: tests query getByRole('switch', { name })). */
  label: string
  size?: 'sm' | 'md'
  disabled?: boolean
  className?: string
}

const TRACK = { sm: 'h-5 w-9', md: 'h-6 w-11' } as const
const THUMB = { sm: 'h-4 w-4', md: 'h-5 w-5' } as const
const SHIFT = { sm: 'translate-x-4', md: 'translate-x-5' } as const

/** On/off switch. Replaces settings/Toggle, the raw icon toggles and click-to-mutate status pills. */
export function Switch({ checked, onChange, label, size = 'md', disabled, className }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex flex-shrink-0 items-center rounded-full p-0.5 transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-brand-strong' : 'bg-ink-500',
        TRACK[size],
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn('inline-block rounded-full bg-white shadow transition-transform', THUMB[size], checked && SHIFT[size])}
      />
    </button>
  )
}
