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
  /** Marks a row's change as in flight (its Switch is off meanwhile) or done. */
  setBusy: (id: string, busy: boolean) => void
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
  deps.setBusy(id, true)
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
    // The list shows the new status before the Switch is usable again.
    await deps.refetch()
    deps.setBusy(id, false)
  }
}

/**
 * Does a save make the item live? A new item (`wasActive` null) or an inactive one saved active does; saving an
 * already-active item, or saving anything inactive, does not. Shared by the list Switch and the editor's Simpan.
 */
export const needsActivationConfirm = (wasActive: boolean | null, willBeActive: boolean): boolean => willBeActive && wasActive !== true

/**
 * Was the row live when the save is sent? The editor holds the row as it was when it opened, so an active row is
 * re-read: someone may have switched it off meanwhile, and saving it active then makes it live again. A failed
 * re-read falls back to the row as loaded.
 */
export async function wasActiveNow<Row extends StatusRow>(row: Row | null, fetchAll: () => Promise<Row[]>): Promise<boolean | null> {
  if (!row) return null
  if (!row.isActive) return false
  try {
    return (await fetchAll()).find((r) => r.id === row.id)?.isActive ?? true
  } catch {
    return true
  }
}

const ACTIVATION_CONSEQUENCE = 'Tablet memakainya setelah sinkron berikutnya.'

/** The D-79 question, in one place: "Aktifkan promo X?" / "Aktifkan kode X?". */
export async function confirmActivation(confirm: StatusToggleDeps['confirm'], noun: string, name: string): Promise<boolean> {
  const answer = await confirm({
    title: `Aktifkan ${noun} ${name}?`,
    consequence: ACTIVATION_CONSEQUENCE,
    confirmLabel: 'Aktifkan',
    initialFocus: 'cancel',
  })
  return answer.confirmed
}

/**
 * Does a Buat Massal batch go live? Every code in it is new, so it asks exactly when the batch is created active. The
 * server stores a missing `isActive` as false, so only an explicit true counts.
 */
export const batchNeedsConfirm = (batch: { isActive?: boolean }): boolean => needsActivationConfirm(null, batch.isActive === true)

/** The D-79 question for Buat Massal, with the number of codes it creates: "Buat 25 kode aktif?". */
export async function confirmBatchActivation(confirm: StatusToggleDeps['confirm'], count: number): Promise<boolean> {
  const answer = await confirm({
    title: `Buat ${count} kode aktif?`,
    consequence: ACTIVATION_CONSEQUENCE,
    confirmLabel: 'Buat kode',
    initialFocus: 'cancel',
  })
  return answer.confirmed
}

/**
 * The list's status Switch (D-79). Turning ON asks first, because the next tablet sync makes it live; turning OFF
 * saves at once and offers "Urungkan". The undo re-reads the row again, so it too sends the fresh row.
 */
export async function toggleStatus<Row extends StatusRow>(kind: StatusToggleKind<Row>, row: Row, next: boolean, deps: StatusToggleDeps): Promise<void> {
  const name = kind.nameOf(row)
  if (next) {
    if (!(await confirmActivation(deps.confirm, kind.noun, name))) return
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
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set())
  const setBusy = useCallback((id: string, busy: boolean) => {
    setBusyIds((prev) => {
      const next = new Set(prev)
      if (busy) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])
  const toggle = useCallback(
    (row: Row, next: boolean) => toggleStatus(kind, row, next, { confirm, toast, refetch, setBusy }),
    [kind, confirm, toast, refetch, setBusy],
  )
  return { toggle, busyIds }
}
