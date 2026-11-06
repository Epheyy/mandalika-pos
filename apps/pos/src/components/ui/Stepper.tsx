type Props = {
  value: number
  onDecrement: () => void
  onIncrement: () => void
  min?: number
  max?: number
  size?: 'md'
  className?: string
}

const BUTTON = 'touch press inline-flex items-center justify-center rounded-control bg-paper-1 text-lg font-semibold text-ink-900 active:bg-paper-2 disabled:opacity-40'

export function Stepper({ value, onDecrement, onIncrement, min, max, className = '' }: Props) {
  return (
    <div className={`inline-flex items-center gap-2 ${className}`.trim()}>
      <button type="button" aria-label="Kurangi" className={BUTTON} disabled={min !== undefined && value <= min} onClick={onDecrement}>
        −
      </button>
      <span className="tnum min-w-8 text-center text-base font-semibold text-ink-900">{value}</span>
      <button type="button" aria-label="Tambah" className={BUTTON} disabled={max !== undefined && value >= max} onClick={onIncrement}>
        +
      </button>
    </div>
  )
}
