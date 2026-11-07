import type { ReactNode } from 'react'
import { cn } from './cn'

interface PageHeaderProps {
  title: ReactNode
  subtitle?: ReactNode
  /** Shown next to the title, outside the h2 so its text stays exact ("312 produk"). */
  count?: ReactNode
  /** Right-aligned action controls (buttons, tabs, switchers). */
  actions?: ReactNode
  className?: string
}

/** Consistent screen header: title + subtitle on the left, actions on the right. */
export function PageHeader({ title, subtitle, count, actions, className }: PageHeaderProps) {
  return (
    <div className={cn('flex items-start justify-between gap-4 flex-wrap', className)}>
      <div className="min-w-0">
        {count ? (
          <div className="flex items-baseline gap-2">
            <h2 className="text-xl font-black text-ink-900">{title}</h2>
            <span className="text-sm font-bold text-ink-700">{count}</span>
          </div>
        ) : (
          <h2 className="text-xl font-black text-ink-900">{title}</h2>
        )}
        {subtitle && <p className="text-sm text-ink-700">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
  )
}
