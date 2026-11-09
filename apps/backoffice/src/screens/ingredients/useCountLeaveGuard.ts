import { useUnsavedChanges } from '../../lib/useUnsavedChanges'
import { useConfirm, type ConfirmOptions } from '../../ui/ConfirmDialog'
import { leaveUnsavedCountConfirm } from './opnameConfirm'

type Ask = (opts: ConfirmOptions) => Promise<{ confirmed: boolean }>

/** The leave question for unsaved ingredient rows; resolves true only on an explicit "Tinggalkan dan buang". */
export function makeCountAskLeave(rows: () => number, ask: Ask): () => Promise<boolean> {
  return async () => (await ask(leaveUnsavedCountConfirm(rows()))).confirmed
}

// Bahan lives under this path; a move that stays under it is not a leave. Moving to Produk, another screen or signing out is.
export const BAHAN_SCOPE = ['inventori', 'opname', 'bahan'] as const

/** Asks before the screen is left (Produk tab, sidebar, sign-out, reload/close) while `unsavedRows` > 0. */
export function useCountLeaveGuard(unsavedRows: number): void {
  const confirm = useConfirm()
  // useUnsavedChanges keeps the latest askLeave in a ref after every commit, so the row count read here is current.
  useUnsavedChanges(unsavedRows > 0, makeCountAskLeave(() => unsavedRows, confirm), BAHAN_SCOPE)
}
