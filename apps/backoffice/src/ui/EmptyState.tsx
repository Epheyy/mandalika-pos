import type { ReactNode } from 'react'
import { cn } from './cn'

interface EmptyStateProps {
  /** A lucide icon element; sized automatically. */
  icon: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  className?: string
}

/** The repeated "Belum ada …" placeholder, standardized. */
export function EmptyState({ icon, title, subtitle, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 p-12 text-center text-gray-300',
        '[&>svg]:h-12 [&>svg]:w-12',
        className,
      )}
    >
      {icon}
      <p className="font-bold text-gray-400">{title}</p>
      {subtitle && <p className="text-sm text-gray-400">{subtitle}</p>}
    </div>
  )
}
