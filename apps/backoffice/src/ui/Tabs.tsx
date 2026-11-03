import { cn } from './cn'

interface TabsProps<T extends string> {
  value: T
  onChange: (value: T) => void
  tabs: ReadonlyArray<{ id: T; label: string; dirty?: boolean }>
  className?: string
}

/** Segmented control (e.g. Pengguna / Manajemen Role). */
export function Tabs<T extends string>({ value, onChange, tabs, className }: TabsProps<T>) {
  return (
    <div className={cn('flex bg-gray-100 rounded-xl p-1', className)}>
      {tabs.map((t) => (
        <button type="button"
          key={t.id}
          data-tab-key={t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            'px-3 py-1.5 rounded-lg text-xs font-bold transition-colors',
            value === t.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700',
          )}
        >
          {t.label}
          {t.dirty && <span aria-hidden="true" data-dirty="true" className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-amber-500 align-middle" />}
        </button>
      ))}
    </div>
  )
}
