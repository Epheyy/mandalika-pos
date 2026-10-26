import { toneClasses, type Tone } from './tone'

type Props = {
  tone: Tone
  label: string
  dot?: boolean
  size?: 'sm' | 'md'
  className?: string
}

const SIZE_CLASSES = {
  sm: 'px-2 py-0.5 text-xs',
  md: 'px-3 py-1 text-sm',
} as const

export function StatusBadge({ tone, label, dot = false, size = 'sm', className = '' }: Props) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-semibold ${toneClasses(tone)} ${SIZE_CLASSES[size]} ${className}`.trim()}
    >
      {dot && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />}
      {label}
    </span>
  )
}
