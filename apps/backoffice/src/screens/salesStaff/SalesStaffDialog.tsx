import { useReducer, useState } from 'react'
import type { Outlet, PullUser, SalesStaff, SalesStaffInput } from '@mandalika/api'
import { Button } from '../../ui/Button'
import { Field, Input, Select } from '../../ui/Field'
import { SlideOver } from '../../ui/SlideOver'
import { Switch } from '../../ui/Switch'
import {
  NAME_MAX,
  NO_LINK,
  hasSalesStaffErrors,
  initialSalesStaffForm,
  linkOptions,
  releaseSalesStaffInput,
  salesStaffFormErrors,
  salesStaffFormReducer,
  toSalesStaffInput,
} from './salesStaffForm'

export const READ_ONLY_NOTE =
  'Sales ini juga bertugas di outlet lain. Anda hanya bisa mengatur outlet Anda; menonaktifkan hanya melepas outlet Anda.'

interface SalesStaffDialogProps {
  /** null = a new person. */
  entry: SalesStaff | null
  /** Outlets the signed-in user covers. */
  outlets: readonly Outlet[]
  /** Accounts that can still be linked (the entry's own account is added here). */
  linkable: readonly PullUser[]
  busy: boolean
  /** Server-side failure of the last save. */
  error: string | null
  onSave: (input: SalesStaffInput) => void
  /** "Lepas dari outlet saya": only offered when the caller may not edit the details. */
  onRelease: (input: SalesStaffInput) => void
  onClose: () => void
}

const NAME_ID = 'sales-staff-name'
const LINK_ID = 'sales-staff-link'

export function SalesStaffDialog({ entry, outlets, linkable, busy, error, onSave, onRelease, onClose }: SalesStaffDialogProps) {
  const [form, dispatch] = useReducer(salesStaffFormReducer, undefined, () =>
    initialSalesStaffForm(entry, outlets.map((o) => o.id)),
  )
  const [attempted, setAttempted] = useState(false)
  const readOnly = entry !== null && !entry.canEditDetails
  const errors = salesStaffFormErrors(form)
  const shown = attempted ? errors : { name: null, outlets: null }
  const options = linkOptions(linkable, entry?.user)

  const save = () => {
    setAttempted(true)
    if (!hasSalesStaffErrors(errors)) onSave(toSalesStaffInput(form))
  }

  return (
    <SlideOver
      open
      onClose={onClose}
      title={entry ? 'Ubah Sales' : 'Tambah Sales'}
      subtitle={entry?.name}
      footer={
        <SlideOver.Footer>
          {readOnly && entry && (
            <Button variant="ghost" disabled={busy} onClick={() => onRelease(releaseSalesStaffInput(entry))}>Lepas dari outlet saya</Button>
          )}
          <Button variant="secondary" disabled={busy} onClick={onClose}>Batal</Button>
          <Button loading={busy} onClick={save}>{busy ? 'Menyimpan...' : 'Simpan'}</Button>
        </SlideOver.Footer>
      }
    >
      <div className="space-y-5">
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {readOnly && <p role="note" className="rounded-xl bg-paper-1 px-3 py-2 text-sm text-ink-700">{READ_ONLY_NOTE}</p>}
        <Input
          id={NAME_ID}
          label="Nama"
          type="text"
          autoComplete="off"
          maxLength={NAME_MAX + 20}
          value={form.name}
          disabled={readOnly}
          error={shown.name}
          onChange={(e) => dispatch({ type: 'SET_NAME', value: e.target.value })}
        />
        <Field label="Outlet" error={shown.outlets}>
          <div role="group" aria-label="Outlet" className="max-h-48 space-y-1 overflow-y-auto rounded-xl border border-paper-2 bg-paper-1 p-3">
            {outlets.map((o) => (
              <label key={o.id} className="flex items-center gap-2 text-sm text-ink-900">
                <input type="checkbox" checked={form.outletIds.includes(o.id)} onChange={() => dispatch({ type: 'TOGGLE_OUTLET', id: o.id })} />
                {o.name}
              </label>
            ))}
          </div>
        </Field>
        <Select
          id={LINK_ID}
          label="Tautkan ke akun"
          value={form.userId}
          disabled={readOnly}
          onChange={(e) => {
            const id = e.target.value
            dispatch({ type: 'SET_USER', userId: id, displayName: options.find((u) => u.id === id)?.displayName })
          }}
        >
          <option value={NO_LINK}>— Tidak ditautkan —</option>
          {options.map((u) => (
            <option key={u.id} value={u.id}>{u.displayName}</option>
          ))}
        </Select>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] font-bold text-ink-700">Aktif</span>
          <Switch checked={form.active} label="Aktif" disabled={readOnly} onChange={(value) => dispatch({ type: 'SET_ACTIVE', value })} />
        </div>
      </div>
    </SlideOver>
  )
}
