import type { ReactNode } from 'react'
import { cn } from '../../ui/cn'
import type { Change } from './settingsDiff'

/** The "Sebelumnya {value}" hint under a row whose value is unsaved (BO3-03). */
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

/** Label + helper on the left, the control on the right; tinted with a "Sebelumnya" hint while its value is unsaved. */
export function SettingRow({ title, hint, change, rule = true, children }: SettingRowProps) {
  return (
    <div
      data-changed={change ? 'true' : undefined}
      className={cn('flex items-center justify-between gap-4 px-3 py-3', change ? 'rounded-xl bg-warn-bg' : rule ? 'border-b border-paper-2' : 'rounded-xl')}
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
