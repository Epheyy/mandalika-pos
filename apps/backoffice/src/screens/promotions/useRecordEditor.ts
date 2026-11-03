import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormProblem } from './promotionForm'

export type EditorLoad = 'loading' | 'ready' | 'missing' | 'failed'

interface RecordEditorArgs<Row extends { id: string }, Input> {
  /** The row to edit (a `?ubah=` id), or null for a new one. */
  recordId: string | null
  /** The whole list, fresh: there is no GET by id, and the row may be on another page of the list. */
  fetchAll: () => Promise<Row[]>
  toInput: (row: Row) => Input
  empty: () => Input
  create: (input: Input) => Promise<unknown>
  update: (id: string, input: Input) => Promise<unknown>
  problemsOf: (input: Input) => FormProblem[]
  /** Called after a successful save (refetch the list, close the editor). */
  onSaved: () => void | Promise<void>
  /**
   * Asked just before a save is sent, with the form and the row as loaded (null for a new one). Resolving false
   * cancels the save: the editor stays open, the form intact, nothing sent.
   */
  confirmSave?: (input: Input, row: Row | null) => Promise<boolean>
  /** Shown when the save is refused without a message. */
  saveFailure: string
  loadFailure: string
}

const messageOf = (e: unknown, fallback: string): string => (e instanceof Error && e.message ? e.message : fallback)

/**
 * One editor session for a promotion or a code: mounted when the overlay opens (`?ubah=` / `?baru=1`) and gone when
 * it closes, so nothing needs resetting. An edit loads the row from the fresh full list, builds the form with the
 * mapper that carries every field, then takes the unsaved-changes baseline from that form. An untouched form is
 * therefore never dirty and saves exactly what was loaded.
 */
export function useRecordEditor<Row extends { id: string }, Input>(args: RecordEditorArgs<Row, Input>) {
  const { recordId, fetchAll, toInput, empty, create, update, problemsOf, onSaved, confirmSave, saveFailure, loadFailure } = args
  const [form, setForm] = useState<Input>(empty)
  const [row, setRow] = useState<Row | null>(null)
  const [load, setLoad] = useState<EditorLoad>(recordId ? 'loading' : 'ready')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [baseline, setBaseline] = useState<string | null>(() => (recordId ? null : JSON.stringify(empty())))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // A save can land after the editor is gone (a route change): it must not then close whatever editor is open now.
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!recordId) return
    let alive = true
    fetchAll()
      .then((rows) => {
        if (!alive) return
        const found = rows.find((r) => r.id === recordId)
        if (!found) {
          setLoadError('Data tidak ditemukan. Mungkin sudah dihapus.')
          setLoad('missing')
          return
        }
        const loaded = toInput(found)
        setRow(found)
        setForm(loaded)
        setBaseline(JSON.stringify(loaded))
        setLoad('ready')
      })
      .catch((e: unknown) => {
        if (!alive) return
        setLoadError(messageOf(e, loadFailure))
        setLoad('failed')
      })
    return () => {
      alive = false
    }
    // The editor is keyed by the record id, so these callbacks are fixed for its lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordId])

  const dirty = load === 'ready' && baseline !== null && JSON.stringify(form) !== baseline
  const problems = useMemo(() => problemsOf(form), [problemsOf, form])
  // A new form opens quiet: "wajib diisi" appears once the user has touched something, other problems at once.
  const shownProblems = dirty ? problems : problems.filter((p) => p.kind !== 'required')

  const askingRef = useRef(false)
  const save = async () => {
    if (busy || askingRef.current || problems.length > 0) return
    if (confirmSave) {
      askingRef.current = true
      let ok = false
      try {
        ok = await confirmSave(form, row)
      } finally {
        askingRef.current = false
      }
      if (!ok || !aliveRef.current) return
    }
    setBusy(true)
    setErr(null)
    try {
      if (recordId) await update(recordId, form)
      else await create(form)
    } catch (e: unknown) {
      if (!aliveRef.current) return
      setErr(messageOf(e, saveFailure))
      setBusy(false)
      return
    }
    if (!aliveRef.current) return
    setBusy(false)
    await onSaved()
  }

  return { form, setForm, row, load, loadError, dirty, busy, err, problems, shownProblems, save }
}
