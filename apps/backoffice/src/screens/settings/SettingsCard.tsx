import type { HTMLAttributes } from 'react'
import { Card } from '../../ui/Card'
import { cn } from '../../ui/cn'

interface SettingsCardProps extends HTMLAttributes<HTMLDivElement> {
  /** The draft holds unsaved changes for this card. */
  changed?: boolean
}

/** Card with the "Belum disimpan" cue: amber left bar plus badge. */
export function SettingsCard({ changed, className, children, ...rest }: SettingsCardProps) {
  return (
    <Card className={cn('relative', changed && 'border-l-4 border-l-amber-400', className)} data-changed={changed ? 'true' : undefined} {...rest}>
      {changed && (
        <span className="absolute top-3 right-4 px-2 py-0.5 rounded-lg bg-amber-50 text-amber-700 text-[11px] font-bold">Belum disimpan</span>
      )}
      {children}
    </Card>
  )
}
