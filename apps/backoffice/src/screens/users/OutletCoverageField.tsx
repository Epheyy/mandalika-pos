import type { Outlet } from '@mandalika/api'
import { Select, Field } from '../../ui/Field'
import { coverageError, setCoverageMode, toggleOutlet, type CoverageValue } from './coverage'
import type { Role } from './roles'

interface OutletCoverageFieldProps {
  role: Role
  value: CoverageValue
  onChange: (v: CoverageValue) => void
  outlets: readonly Outlet[]
}

/** Outlet coverage of a user: one home outlet for a cashier, All or a ticked list (with a home) for a manager. Hidden for an admin. */
export function OutletCoverageField({ role, value, onChange, outlets }: OutletCoverageFieldProps) {
  if (role === 'admin') return null
  const error = coverageError(role, value)
  if (role === 'cashier') {
    return (
      <div className="space-y-1">
        <Select
          label="Outlet"
          value={value.homeId}
          onChange={(e) => onChange({ mode: 'specific', homeId: e.target.value, outletIds: e.target.value ? [e.target.value] : [] })}
        >
          <option value="">Pilih outlet</option>
          {outlets.map((o) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
        </Select>
        {error && <p role="alert" className="text-[11px] text-danger">{error}</p>}
      </div>
    )
  }
  const ticked = outlets.filter((o) => value.outletIds.includes(o.id))
  return (
    <div className="space-y-3">
      <Field label="Outlet">
        <div role="radiogroup" aria-label="Cakupan outlet" className="flex gap-4 text-sm text-ink-900">
          {(['all', 'specific'] as const).map((m) => (
            <label key={m} className="flex items-center gap-2">
              <input type="radio" name="outlet-coverage-mode" checked={value.mode === m} onChange={() => onChange(setCoverageMode(value, m))} />
              {m === 'all' ? 'Semua Outlet' : 'Outlet tertentu'}
            </label>
          ))}
        </div>
      </Field>
      {value.mode === 'specific' && (
        <>
          <div role="group" aria-label="Outlet yang dicakup" className="max-h-40 space-y-1 overflow-y-auto rounded-xl border border-paper-2 bg-paper-1 p-3">
            {outlets.map((o) => (
              <label key={o.id} className="flex items-center gap-2 text-sm text-ink-900">
                <input type="checkbox" checked={value.outletIds.includes(o.id)} onChange={() => onChange(toggleOutlet(value, o.id))} />
                {o.name}
              </label>
            ))}
          </div>
          {ticked.length > 0 && (
            <Select label="Outlet utama" value={value.homeId} onChange={(e) => onChange({ ...value, homeId: e.target.value })}>
              {ticked.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </Select>
          )}
        </>
      )}
      {error && <p role="alert" className="text-[11px] text-danger">{error}</p>}
    </div>
  )
}
