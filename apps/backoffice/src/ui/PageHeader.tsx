import type { ReactNode } from 'react'
import { cn } from './cn'

interface PageHeaderProps {
  title: ReactNode
  subtitle?: ReactNode
  /** Right-aligned action controls (buttons, tabs, switchers). */
  actions?: ReactNode
  className?: string
}

/** Consistent screen header: title + subtitle on the left, actions on the right. */
export function PageHeader({ title, subtitle, actions, className }: PageHeaderProps) {
  return (
    <div className={cn('flex items-start justify-between gap-4 flex-wrap', className)}>
      <div className="min-w-0">
        <h2 className="text-xl font-black text-gray-900">{title}</h2>
        {subtitle && <p className="text-sm text-gray-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
  )
}
