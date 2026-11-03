import { useEffect, useRef, type RefObject } from 'react'
import { useUnsavedChanges } from '../../lib/useUnsavedChanges'
import { useConfirm } from '../../ui/ConfirmDialog'
import { useToast } from '../../ui/Toast'
import type { EditorLoad } from './useRecordEditor'

/**
 * Step 1, before the editor hook: `leave` closes the overlay without a question (after a save, or an answered
 * "Buang perubahan"). It marks the question as answered so the leave guard does not ask again on the way out.
 */
export function useLeave(closeEditor: () => void) {
  const answeredRef = useRef(false)
  const leave = () => {
    answeredRef.current = true
    closeEditor()
  }
  return { answeredRef, leave }
}

interface GuardArgs {
  answeredRef: RefObject<boolean>
  leave: () => void
  dirty: boolean
  load: EditorLoad
  closeEditor: () => void
  /** "promosi" or "kode diskon": used in the sentences. */
  subject: string
}

/**
 * Step 2, after the editor hook: the editor's single leave question. Unsaved changes are guarded by ONE dialog that
 * covers every way out: ×, Escape, the backdrop, browser Back, the sidebar and a typed URL (the scoped leave guard).
 * A row that vanished (`load === 'missing'`) closes with a toast. Returns the handler for ×, Batal and Escape.
 */
export function useEditorGuard({ answeredRef, leave, dirty, load, closeEditor, subject }: GuardArgs) {
  const confirm = useConfirm()
  const toast = useToast()

  const askLeave = async (): Promise<boolean> => {
    // Nothing unsaved (or already answered): leaving needs no question, so a plain x on an untouched form just closes.
    if (answeredRef.current || !dirty) return true
    const answer = await confirm({
      title: 'Buang perubahan?',
      consequence: `Perubahan pada ${subject} ini belum disimpan dan akan hilang.`,
      confirmLabel: 'Buang perubahan',
      cancelLabel: 'Lanjut edit',
      tone: 'danger',
    })
    return answer.confirmed
  }
  useUnsavedChanges(dirty, askLeave)

  useEffect(() => {
    if (load !== 'missing') return
    toast({ message: `${subject.charAt(0).toUpperCase()}${subject.slice(1)} tidak ditemukan. Mungkin sudah dihapus.`, tone: 'warn' })
    answeredRef.current = true
    closeEditor()
  }, [load, toast, closeEditor, subject, answeredRef])

  return async () => {
    if (await askLeave()) leave()
  }
}
