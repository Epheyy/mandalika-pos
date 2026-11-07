import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { CalendarDays, Search } from 'lucide-react'
import { localDay } from '../lib/businessDay'
import { useOptionalOutlet } from '../outlet'
import { cn } from './cn'

interface FilterBarProps {
  children: ReactNode
  /** Right side: export button, refresh. */
  actions?: ReactNode
  onReset?: () => void
  /** Number of filters that differ from the default; the reset button hides at 0. */
  activeCount?: number
}

const CONTROL =
  'h-10 rounded-xl border border-paper-2 bg-white px-3 text-[13px] text-ink-900 focus:outline-none ' +
  'focus:ring-2 focus:ring-brand-strong'
const CHIP =
  'h-10 rounded-xl px-4 text-[13px] font-bold focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-strong'
const CHIP_OFF = 'bg-paper-1 text-ink-700 hover:bg-paper-2'
const RANGE_INPUT = 'h-8 bg-transparent text-[13px] font-bold text-ink-900 focus:outline-none'
const CHIP_ON = 'bg-brand-strong text-on-brand'

/** Layout shell for a list's filters. Values live in the screen (useListState); parts are static members. */
export function FilterBar({ children, actions, onReset, activeCount }: FilterBarProps) {
  const showReset = !!onReset && (activeCount === undefined || activeCount > 0)
  return (
    <div role="search" aria-label="Filter daftar" className="surface-group flex flex-wrap items-center gap-3 rounded-2xl px-4 py-3">
      {children}
      {(actions || showReset) && (
        <div className="ml-auto flex items-center gap-2">
          {showReset && (
            <button
              type="button"
              onClick={onReset}
              className="rounded-lg px-2 py-1 text-xs font-bold text-ink-700 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-strong"
            >
              Atur ulang filter{activeCount ? ` (${activeCount})` : ''}
            </button>
          )}
          {actions}
        </div>
      )}
    </div>
  )
}

/** "Cakupan: {outlet} · mengikuti pilihan di header". Standalone (no provider) it reads "Semua outlet". */
function Scope({ extra }: { extra?: string }) {
  const outlet = useOptionalOutlet()
  const name = outlet?.outletId ? (outlet.outlets.find((o) => o.id === outlet.outletId)?.name ?? 'Outlet terpilih') : 'Semua outlet'
  return (
    <p className="self-center text-xs font-bold text-ink-700">
      Cakupan: {[name, extra].filter(Boolean).join(' · ')} · mengikuti pilihan di header
    </p>
  )
}

interface SearchProps {
  value: string
  onChange: (value: string) => void
  /** The aria-label. Never just "Cari": scenarios match labels by substring. */
  label: string
  placeholder?: string
  debounceMs?: number
}

const DEFAULT_DEBOUNCE_MS = 300

function SearchField({ value, onChange, label, placeholder, debounceMs = DEFAULT_DEBOUNCE_MS }: SearchProps) {
  const [text, setText] = useState(value)
  const emitted = useRef(value)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef(onChange)
  useEffect(() => {
    latest.current = onChange
  })

  // An outside change (reset, URL) replaces what is typed.
  useEffect(() => {
    if (value !== emitted.current) {
      emitted.current = value
      // A keystroke still waiting to be emitted belongs to the old value: drop it.
      if (timer.current) clearTimeout(timer.current)
      setText(value)
    }
  }, [value])

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const type = (next: string) => {
    setText(next)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      emitted.current = next
      latest.current(next)
    }, debounceMs)
  }

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-500" aria-hidden="true" />
      <input
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={text}
        onChange={(e) => type(e.target.value)}
        className={cn(CONTROL, 'w-64 pl-9')}
      />
    </div>
  )
}

export type DatePreset = 'hari-ini' | '7-hari' | '30-hari' | 'bulan-ini'
const PRESET_LABEL: Record<DatePreset, string> = {
  'hari-ini': 'Hari ini',
  '7-hari': '7 hari',
  '30-hari': '30 hari',
  'bulan-ini': 'Bulan ini',
}

/** Local-day bounds (YYYY-MM-DD) of a preset, relative to `now`. */
export function presetRange(preset: DatePreset, now: Date = new Date()): { from: string; to: string } {
  const to = localDay(now)
  if (preset === 'hari-ini') return { from: to, to }
  if (preset === 'bulan-ini') return { from: localDay(new Date(now.getFullYear(), now.getMonth(), 1)), to }
  const back = preset === '7-hari' ? 6 : 29
  return { from: localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back)), to }
}

interface DateRangeProps {
  from: string
  to: string
  onChange: (range: { from: string; to: string }) => void
  presets?: readonly DatePreset[]
}

function DateRange({ from, to, onChange, presets }: DateRangeProps) {
  const uid = useId()
  // The preset whose range equals the current one reads as selected (white thumb); a hand-picked range selects none.
  const active = presets?.find((p) => {
    const r = presetRange(p)
    return r.from === from && r.to === to
  })
  return (
    <div className="flex flex-wrap items-center gap-2">
      {presets && presets.length > 0 && (
        <div role="group" aria-label="Rentang cepat" className="flex h-10 items-center gap-0.5 rounded-xl bg-paper-1 p-1">
          {presets.map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={active === p}
              onClick={() => onChange(presetRange(p))}
              className={cn(
                'h-8 rounded-lg px-3 text-[13px] font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-strong',
                active === p
                  ? 'bg-white font-bold text-brand-strong ring-1 ring-brand-strong shadow-[0_0_0_0.5px_rgba(26,16,8,0.08),0_3px_10px_-2px_rgba(70,46,10,0.18)]'
                  : 'text-ink-700 hover:bg-paper-2',
              )}
            >
              {PRESET_LABEL[p]}
            </button>
          ))}
        </div>
      )}
      <div className="flex h-10 items-center gap-2 rounded-xl bg-paper-1 px-3 focus-within:ring-2 focus-within:ring-brand-strong">
        <CalendarDays className="h-4 w-4 flex-shrink-0 text-ink-500" aria-hidden="true" />
        <label htmlFor={`${uid}-from`} className="text-[13px] font-semibold text-ink-700">
          Dari
        </label>
        <input id={`${uid}-from`} type="date" value={from} max={to || undefined} onChange={(e) => onChange({ from: e.target.value, to })} className={RANGE_INPUT} />
        <label htmlFor={`${uid}-to`} className="text-[13px] font-semibold text-ink-700">
          Sampai
        </label>
        <input id={`${uid}-to`} type="date" value={to} min={from || undefined} onChange={(e) => onChange({ from, to: e.target.value })} className={RANGE_INPUT} />
      </div>
    </div>
  )
}

interface ChipItem {
  id: string
  label: string
  count?: number
}
type ChipsProps = { items: readonly ChipItem[]; label?: string } & (
  | { multiple?: false; value: string; onChange: (value: string) => void }
  | { multiple: true; value: string[]; onChange: (value: string[]) => void }
)

function Chips(props: ChipsProps) {
  const selected = (id: string) => (props.multiple ? props.value.includes(id) : props.value === id)
  const pick = (id: string) => {
    if (props.multiple) {
      props.onChange(props.value.includes(id) ? props.value.filter((v) => v !== id) : [...props.value, id])
    } else {
      props.onChange(id)
    }
  }
  return (
    <div role="group" aria-label={props.label} className="flex flex-wrap gap-2">
      {props.items.map((it) => (
        <button
          key={it.id}
          type="button"
          aria-pressed={selected(it.id)}
          onClick={() => pick(it.id)}
          className={cn(
            CHIP,
            selected(it.id) ? CHIP_ON : CHIP_OFF,
          )}
        >
          {it.label}
          {it.count !== undefined && (
            <>
              <span className="sr-only"> </span>
              <span className="ml-1.5 text-xs tabular-nums">{it.count}</span>
            </>
          )}
        </button>
      ))}
    </div>
  )
}

interface SelectProps {
  label: string
  value: string
  onChange: (value: string) => void
  options: readonly { value: string; label: string }[]
  disabled?: boolean
}

/** A native <select> with an inline prefix ("Kategori: Semua"). The accessible name is the label via aria-label,
 *  so no label sits stacked above the control (plan 2.3). */
function SelectField({ label, value, onChange, options, disabled }: SelectProps) {
  return (
    <div
      className={cn(
        'flex h-10 items-center gap-1.5 rounded-xl bg-paper-1 pl-3 pr-1 text-[13px] focus-within:ring-2 focus-within:ring-brand-strong',
        disabled && 'opacity-60',
      )}
    >
      <span aria-hidden="true" className="flex-shrink-0 text-ink-700">
        {label}:
      </span>
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="h-full min-w-0 flex-1 bg-transparent pr-1 font-bold text-ink-900 focus:outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}

FilterBar.Scope = Scope
FilterBar.Search = SearchField
FilterBar.DateRange = DateRange
FilterBar.Chips = Chips
FilterBar.Select = SelectField
