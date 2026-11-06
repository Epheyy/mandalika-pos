import { cn } from '../../ui/cn'
import { ROLES, ROLE_LABEL, type Role } from './roles'

interface RolePickerProps {
  value: Role
  onChange: (role: Role) => void
}

/** Pick one of the three base roles. Selected state uses the kit brand tokens and aria-pressed. */
export function RolePicker({ value, onChange }: RolePickerProps) {
  return (
    <div role="group" aria-label="Role" className="grid grid-cols-3 gap-2">
      {ROLES.map((r) => (
        <button
          type="button"
          key={r}
          aria-pressed={value === r}
          onClick={() => onChange(r)}
          className={cn(
            'rounded-xl border-2 py-2.5 text-sm font-bold focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-strong',
            value === r ? 'border-brand-strong bg-paper-1 text-brand-strong' : 'border-paper-2 text-ink-700 hover:bg-paper-0',
          )}
        >
          {ROLE_LABEL[r]}
        </button>
      ))}
    </div>
  )
}
