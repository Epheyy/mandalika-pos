import { cn } from './cn'
import { labelOf, type EnumLabel, type LabelMap, type Tone } from '../lib/labels/types'

/** Token classes per tone. Text colours are the AA-safe ones (warn uses warn-strong on warn-bg). */
export const TONE_CLASS: Readonly<Record<Tone, string>> = {
  ok: 'bg-ok-bg text-ok',
  warn: 'bg-warn-bg text-warn-strong',
  danger: 'bg-danger-bg text-danger',
  info: 'bg-info-bg text-info',
  promo: 'bg-promo-bg text-promo',
  reward: 'bg-reward-bg text-reward',
  neutral: 'bg-paper-1 text-ink-700',
}

type StatusBadgeProps<K extends string> =
  | { map: LabelMap<K>; value: string | null | undefined; className?: string }
  | { tone: Tone; label: string; hint?: string; className?: string }

/** Status pill: tinted, a coloured dot and the word (colour is never the only cue). Either looks a code up in a label map (unknown codes read "Lainnya", never raw) or takes a tone + label. */
export function StatusBadge<K extends string>(props: StatusBadgeProps<K>) {
  const entry: EnumLabel =
    'map' in props ? labelOf(props.map, props.value) : { tone: props.tone, label: props.label, hint: props.hint }
  return (
    <span
      title={entry.hint}
      className={cn('inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold rounded-lg', TONE_CLASS[entry.tone], props.className)}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-current" />
      {entry.label}
    </span>
  )
}
