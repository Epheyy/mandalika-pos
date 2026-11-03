import { useCallback, useState } from 'react'
import { useConfirm, type ConfirmOptions, type ConfirmResult } from '../../ui/ConfirmDialog'
import { useToast, type ToastInput } from '../../ui/Toast'

interface StatusRow {
  id: string
  isActive: boolean
}

/** What differs between promotions and codes. */
export interface StatusToggleKind<Row extends StatusRow> {
  /** "promo" or "kode": used in the sentences. */
  noun: string
  nameOf: (row: Row) => string
  /** The whole list from the server, not the visible page: the row to send is read from here, fresh. */
  fetchAll: () => Promise<Row[]>
  /** PUT the row with its status set: built from the FRESH row with every field carried. */
  save: (fresh: Row, isActive: boolean) => Promise<void>
}

export interface StatusToggleDeps {
  confirm: (opts: ConfirmOptions) => Promise<ConfirmResult>
  toast: (t: ToastInput) => void
  refetch: () => Promise<unknown>
  /** Marks the row whose change is in flight (its Switch is off meanwhile); null clears it. */
  setBusy: (id: string | null) => void
}

const errorMessage = (e: unknown, fallback: string): string => (e instanceof Error && e.message ? e.message : fallback)
const sentence = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * Set a row's status from a FRESH read: find the row in the full list, send all of it with only the status changed.
 * Returns the row that was saved, or null (not found, or the save was refused: a toast says which).
 */
export async function changeStatus<Row extends StatusRow>(
  kind: StatusToggleKind<Row>,
  id: string,
  isActive: boolean,
  deps: Pick<StatusToggleDeps, 'toast' | 'refetch' | 'setBusy'>,
): Promise<Row | null> {
  deps.setBusy(id)
  try {
    const fresh = (await kind.fetchAll()).find((r) => r.id === id)
    if (!fresh) {
      deps.toast({ message: `${sentence(kind.noun)} tidak ditemukan. Mungkin sudah dihapus.`, tone: 'warn' })
      return null
    }
    await kind.save(fresh, isActive)
    return fresh
  } catch (e: unknown) {
    deps.toast({ message: errorMessage(e, `Status ${kind.noun} gagal diubah.`), tone: 'warn' })
    return null
  } finally {
    deps.setBusy(null)
    await deps.refetch()
  }
}

/**
 * The list's status Switch (D-79). Turning ON asks first, because the next tablet sync makes it live; turning OFF
 * saves at once and offers "Urungkan". The undo re-reads the row again, so it too sends the fresh row.
 */
export async function toggleStatus<Row extends StatusRow>(kind: StatusToggleKind<Row>, row: Row, next: boolean, deps: StatusToggleDeps): Promise<void> {
  const name = kind.nameOf(row)
  if (next) {
    const answer = await deps.confirm({
      title: `Aktifkan ${kind.noun} ${name}?`,
      consequence: 'Tablet memakainya setelah sinkron berikutnya.',
      confirmLabel: 'Aktifkan',
    })
    if (!answer.confirmed) return
    await changeStatus(kind, row.id, true, deps)
    return
  }
  const done = await changeStatus(kind, row.id, false, deps)
  if (!done) return
  deps.toast({
    message: `${sentence(kind.noun)} ${name} dinonaktifkan`,
    tone: 'info',
    action: { label: 'Urungkan', onClick: () => void changeStatus(kind, row.id, true, deps) },
    durationMs: 8000,
  })
}

/** Pass a module-level `kind` (its identity keys the callback). */
export function useStatusToggle<Row extends StatusRow>(kind: StatusToggleKind<Row>, refetch: () => Promise<unknown>) {
  const confirm = useConfirm()
  const toast = useToast()
  const [busyId, setBusyId] = useState<string | null>(null)
  const toggle = useCallback(
    (row: Row, next: boolean) => toggleStatus(kind, row, next, { confirm, toast, refetch, setBusy: setBusyId }),
    [kind, confirm, toast, refetch],
  )
  return { toggle, busyId }
}
