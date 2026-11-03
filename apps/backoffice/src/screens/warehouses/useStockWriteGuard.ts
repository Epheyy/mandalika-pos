import { useCallback } from 'react'
import { useUnsavedChanges } from '../../lib/useUnsavedChanges'
import { useConfirm } from '../../ui/ConfirmDialog'

/**
 * Keeps a stock-write panel from being left by the browser (Back, a sidebar click) behind its own back.
 * While the write is in flight the move is refused: the panel would unmount with the write still landing, and a
 * reopen would send a new Idempotency-Key. While the form holds unsaved input the user is asked first.
 */
export function useStockWriteGuard(busy: boolean, dirty: boolean): void {
  const confirm = useConfirm()
  const askLeave = useCallback(async (): Promise<boolean> => {
    if (busy) return false
    const { confirmed } = await confirm({
      title: 'Buang perubahan?',
      consequence: 'Isian yang belum disimpan akan hilang.',
      confirmLabel: 'Buang perubahan',
      cancelLabel: 'Lanjut edit',
      tone: 'danger',
    })
    return confirmed
  }, [busy, confirm])
  useUnsavedChanges(busy || dirty, askLeave)
}
