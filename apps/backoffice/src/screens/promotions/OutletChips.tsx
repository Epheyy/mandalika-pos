import type { Outlet } from '@mandalika/api'
import { cn } from '../../ui/cn'

interface OutletChipsProps {
  outlets: readonly Outlet[]
  /** Selected outlet ids; empty means every outlet. */
  value: readonly string[]
  onChange: (next: string[]) => void
}

const CHIP =
  'rounded-full border h-10 px-4 text-[13px] font-bold focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-strong'
const ON = 'border-brand-strong bg-brand-strong text-on-brand'
const OFF = 'border-paper-2 bg-white text-ink-700 hover:bg-paper-1'

/**
 * "Semua outlet" first, then one chip per outlet. Empty selection is "Semua outlet" and is never expanded into every
 * id. Ids the outlet list does not know (a removed outlet) stay selected and show as removable chips, so an edit
 * cannot silently drop them.
 */
export function OutletChips({ outlets, value, onChange }: OutletChipsProps) {
  const known = new Set(outlets.map((o) => o.id))
  const unknown = value.filter((id) => !known.has(id))
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])
  return (
    <div role="group" aria-label="Outlet" className="flex flex-wrap gap-2">
      <button type="button" aria-pressed={value.length === 0} onClick={() => onChange([])} className={cn(CHIP, value.length === 0 ? ON : OFF)}>
        Semua outlet
      </button>
      {outlets.map((o) => (
        <button key={o.id} type="button" aria-pressed={value.includes(o.id)} onClick={() => toggle(o.id)} className={cn(CHIP, value.includes(o.id) ? ON : OFF)}>
          {o.name}
        </button>
      ))}
      {unknown.map((id) => (
        <button key={id} type="button" aria-pressed title={`Outlet ${id} tidak ada di daftar. Klik untuk melepas.`} onClick={() => toggle(id)} className={cn(CHIP, ON)}>
          Outlet tidak dikenal
        </button>
      ))}
    </div>
  )
}
