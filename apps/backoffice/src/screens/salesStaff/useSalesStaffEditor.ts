import { useRef, useState } from 'react'
import type { PullUser, SalesStaff, SalesStaffInput } from '@mandalika/api'
import { api } from '../../api'
import { errorText } from '../users/formError'
import { nextSaveAttempt, type SaveAttempt } from './salesStaffForm'

export const RELEASED_NOTE = 'Sales dilepas dari outlet Anda.'

export interface Editor {
  entry: SalesStaff | null
  linkable: PullUser[]
}

/** Editor state of the Tim Sales page: open (with the linkable accounts), save with a retry-safe key, close. */
export function useSalesStaffEditor(onSaved: (note: string | null) => Promise<void> | void) {
  const [editor, setEditor] = useState<Editor | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // One Idempotency-Key per payload: a retry after a lost response replays the same write; an edit mints a new key.
  const attempt = useRef<SaveAttempt | null>(null)
  // Which open the linkable-users response belongs to; a slower earlier response is ignored.
  const openSeq = useRef(0)

  const open = async (entry: SalesStaff | null) => {
    const seq = ++openSeq.current
    attempt.current = null
    setError(null)
    let next: Editor
    try {
      next = { entry, linkable: await api.listSalesStaffLinkableUsers() }
    } catch (e: unknown) {
      if (seq !== openSeq.current) return
      setError(errorText(e, 'Gagal memuat akun yang bisa ditautkan.'))
      next = { entry, linkable: [] }
    }
    if (seq === openSeq.current) setEditor(next)
  }

  const close = () => {
    if (busy) return
    openSeq.current++
    attempt.current = null
    setEditor(null)
  }

  const save = async (input: SalesStaffInput, successNote: string | null) => {
    if (!editor || busy) return
    setBusy(true)
    setError(null)
    attempt.current = nextSaveAttempt(attempt.current, editor.entry?.id ?? null, input)
    const key = attempt.current.key
    try {
      const saved = editor.entry ? await api.updateSalesStaff(editor.entry.id, input, key) : await api.createSalesStaff(input, key)
      attempt.current = null
      setEditor(null)
      // A manager who removed their own outlets from a shared person no longer sees the row: say so instead of failing.
      await onSaved(saved.outletIds.length === 0 ? RELEASED_NOTE : successNote)
    } catch (e: unknown) {
      setError(errorText(e, 'Gagal menyimpan. Coba lagi.'))
    } finally {
      setBusy(false)
    }
  }

  return { editor, busy, error, open, close, save }
}
