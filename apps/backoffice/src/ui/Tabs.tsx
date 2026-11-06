import { useRef, type KeyboardEvent } from 'react'
import { cn } from './cn'

/** The tab that Left/Right/Home/End move focus to, or null for any other key. Wraps around. */
export function nextTabIndex(key: string, index: number, count: number): number | null {
  const last = count - 1
  if (last < 0) return null
  if (key === 'ArrowRight') return index === last ? 0 : index + 1
  if (key === 'ArrowLeft') return index === 0 ? last : index - 1
  if (key === 'Home') return 0
  if (key === 'End') return last
  return null
}

interface TabsProps<T extends string> {
  value: T
  onChange: (value: T) => void
  tabs: ReadonlyArray<{ id: T; label: string; dirty?: boolean }>
  className?: string
  /** For a strip nested under another one: its data-tab-key becomes "scope.id", so keys stay unique on the page. */
  scope?: string
  /** Accessible name of the strip when the surrounding heading doesn't name it. */
  label?: string
}

/**
 * Segmented control (e.g. Pengguna / Manajemen Role) with the WAI-ARIA tab pattern: role tablist/tab,
 * aria-selected, a roving tabindex, and Left/Right/Home/End to move focus.
 *
 * Activation is manual: arrows only move focus, Enter/Space (a native button click) selects. Selecting changes the
 * URL and can raise the unsaved-changes guard, so it must not fire on every arrow press. No aria-controls: the
 * screens that own the panels don't mark them as tabpanels yet.
 */
export function Tabs<T extends string>({ value, onChange, tabs, className, scope, label }: TabsProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  // With no matching value (a stale URL) the first tab stays reachable by keyboard.
  const tabStop = tabs.some((t) => t.id === value) ? value : tabs[0]?.id

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const target = nextTabIndex(e.key, index, tabs.length)
    if (target === null) return
    e.preventDefault()
    refs.current[target]?.focus()
  }

  return (
    <div role="tablist" aria-label={label} className={cn('inline-flex h-10 items-center rounded-xl bg-ink-900/5 p-1', className)}>
      {tabs.map((t, i) => {
        const selected = value === t.id
        return (
          <button
            type="button"
            role="tab"
            key={t.id}
            ref={(el) => {
              refs.current[i] = el
            }}
            data-tab-key={scope ? `${scope}.${t.id}` : t.id}
            aria-selected={selected}
            tabIndex={t.id === tabStop ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              // Same weight selected or not, tabular figures: the strip never changes width on selection.
              'h-8 whitespace-nowrap rounded-lg px-3 text-[13px] font-semibold tabular-nums transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-strong',
              selected ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-700 hover:text-ink-900',
            )}
          >
            {t.label}
            {t.dirty && (
              <span aria-hidden="true" data-dirty="true" className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-warn align-middle" />
            )}
          </button>
        )
      })}
    </div>
  )
}
