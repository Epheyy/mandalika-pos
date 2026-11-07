import type { HTMLAttributes, ReactNode } from 'react'
import { Card } from '../../ui/Card'
import { cn } from '../../ui/cn'

interface SettingsCardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** The draft holds unsaved changes for this card. */
  changed?: boolean
  /** Card heading; with it the "Belum disimpan" tag sits right after the title (BO3-03). */
  title?: ReactNode
}

const TAG = 'px-2 py-0.5 rounded-lg bg-warn-bg text-warn-strong text-[11px] font-bold'

/** Card with the "Belum disimpan" cue: a tag after the title (the changed rows carry their own tint, see SettingRow). */
export function SettingsCard({ changed, title, className, children, ...rest }: SettingsCardProps) {
  return (
    <Card className={cn('relative', className)} data-changed={changed ? 'true' : undefined} {...rest}>
      {title ? (
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-black text-ink-900">{title}</h3>
          {changed && <span className={TAG}>Belum disimpan</span>}
        </div>
      ) : (
        changed && <span className={cn('absolute top-3 right-4', TAG)}>Belum disimpan</span>
      )}
      {children}
    </Card>
  )
}
