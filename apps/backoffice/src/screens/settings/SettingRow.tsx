import type { ReactNode } from 'react'
import { cn } from '../../ui/cn'
import type { Change } from './settingsDiff'

/** The pending change for one setting path, if the draft differs from the saved value. */
export const changeAt = (changes: readonly Change[], path: string): Change | undefined => changes.find((c) => c.path === path)

/** Peach tint plus a "Sebelumnya {value}" hint for a row whose value is unsaved (BO3-03). Shared by every Pengaturan row. */
export function ChangedHint({ change }: { change: Change | undefined }) {
  if (!change) return null
  return <p className="text-xs font-bold text-warn-strong">Sebelumnya {change.from}</p>
}

interface SettingRowProps {
  title: ReactNode
  hint?: ReactNode
  change?: Change
  /** Bottom rule between rows (default on). */
  rule?: boolean
  children: ReactNode
}

/** Label + helper on the left, the control on the right. */
export function SettingRow({ title, hint, change, rule = true, children }: SettingRowProps) {
  return (
    <div
      data-changed={change ? 'true' : undefined}
      className={cn('flex items-center justify-between gap-4 px-3 py-3 rounded-xl', rule && !change && 'border-b border-paper-2 rounded-none', change && 'bg-warn-bg')}
    >
      <div>
        <p className="font-bold text-ink-900">{title}</p>
        {hint && <p className="text-xs text-ink-700">{hint}</p>}
        <ChangedHint change={change} />
      </div>
      {children}
    </div>
  )
}
