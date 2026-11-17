import { useState } from 'react'
import { RECEIPT_LIMITS } from '@mandalika/printer/render'
import { Button } from '../../../ui/Button'
import { Input } from '../../../ui/Field'
import { Modal } from '../../../ui/Modal'

interface NameDialogProps {
  open: boolean
  title: string
  confirmLabel: string
  initial: string
  onConfirm: (name: string) => void
  onClose: () => void
}

/** Asks for a template name (new, duplicate, rename). */
export function NameDialog({ open, title, confirmLabel, initial, onConfirm, onClose }: NameDialogProps) {
  if (!open) return null
  return <NameBody title={title} confirmLabel={confirmLabel} initial={initial} onConfirm={onConfirm} onClose={onClose} />
}

function NameBody({ title, confirmLabel, initial, onConfirm, onClose }: Omit<NameDialogProps, 'open'>) {
  const [name, setName] = useState(initial)
  const trimmed = name.trim()
  const valid = trimmed.length >= 1 && [...trimmed].length <= RECEIPT_LIMITS.nameMax
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Batal</Button>
          <Button disabled={!valid} onClick={() => onConfirm(trimmed)}>{confirmLabel}</Button>
        </>
      }
    >
      <form onSubmit={(e) => { e.preventDefault(); if (valid) onConfirm(trimmed) }}>
        <Input
          label="Nama template"
          type="text"
          value={name}
          maxLength={RECEIPT_LIMITS.nameMax}
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
      </form>
    </Modal>
  )
}

interface OutletRef {
  id: string
  name: string
}

interface AssignOutletsDialogProps {
  open: boolean
  outlets: readonly OutletRef[]
  /** Outlets that print this template now. */
  assigned: readonly string[]
  /** Standar is where an unassigned outlet lands, so its current outlets can only be moved by picking another template. */
  isStandar: boolean
  saving: boolean
  error: string | null
  onSave: (outletIds: string[]) => void
  onClose: () => void
}

export function AssignOutletsDialog(props: AssignOutletsDialogProps) {
  if (!props.open) return null
  return <AssignBody {...props} />
}

function AssignBody({ outlets, assigned, isStandar, saving, error, onSave, onClose }: AssignOutletsDialogProps) {
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set(assigned))
  const locked = (id: string): boolean => isStandar && assigned.includes(id)
  const toggle = (id: string): void => {
    if (locked(id)) return
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Pakai di outlet"
      subtitle={isStandar ? 'Outlet tanpa template memakai Standar. Pilih outlet untuk memindahkannya ke Standar.' : 'Outlet yang tidak dicentang kembali memakai Standar.'}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Batal</Button>
          <Button loading={saving} onClick={() => onSave([...checked])}>Simpan</Button>
        </>
      }
    >
      {error && <p role="alert" className="mb-3 text-sm font-bold text-danger">{error}</p>}
      {outlets.length === 0 ? (
        <p className="text-sm text-ink-700">Belum ada outlet.</p>
      ) : (
        <ul className="divide-y divide-paper-2 rounded-xl border border-paper-2">
          {outlets.map((o) => (
            <li key={o.id}>
              <label className="flex cursor-pointer items-center gap-3 px-4 py-2.5 text-sm font-bold text-ink-900">
                <input
                  type="checkbox"
                  className="accent-brand-strong"
                  checked={checked.has(o.id)}
                  disabled={locked(o.id)}
                  onChange={() => toggle(o.id)}
                />
                {o.name}
              </label>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
