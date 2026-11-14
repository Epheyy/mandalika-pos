import { StatusBadge } from '../../components/ui/StatusBadge'
import { VOID_BLOCKED_REFUNDED, type VoidAvailability } from './voidRules'

interface VoidActionProps {
  availability: VoidAvailability
  onVoid: () => void
  onCreateReplacement: () => void
}

/** "Batalkan" for a sale this cashier may void, "Buat pengganti" for an older voided sale, or a muted line saying why
 *  not. The gate is UI-only: the server decides again. */
export function VoidAction({ availability, onVoid, onCreateReplacement }: VoidActionProps) {
  if (availability.kind === 'hidden') return null
  if (availability.kind === 'blocked') {
    return <StatusBadge tone={availability.label === VOID_BLOCKED_REFUNDED ? 'neutral' : 'warn'} size="md" label={availability.label} className="mt-2 w-full justify-center" />
  }
  const replace = availability.kind === 'create_replacement'
  return (
    <button type="button" onClick={replace ? onCreateReplacement : onVoid}
      className={`mt-2 w-full min-h-12 border rounded-control text-sm font-semibold press ${replace ? 'border-brand-strong text-brand-strong active:bg-paper-1' : 'border-danger text-danger active:bg-danger-bg'}`}>
      {replace ? 'Buat pengganti' : 'Batalkan'}
    </button>
  )
}
