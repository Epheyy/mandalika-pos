/**
 * Permintaan Barang (PB): the cashier raises, submits, cancels and tracks stock requests for this
 * outlet. Online-only: every call goes through requisitionFlow (never the outbox). A full-height
 * slide-over with an in-screen list / detail / form swap (no router). The warehouse actions
 * (approve, reject, fulfil) are never rendered or called here.
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { Product, StockRequisition } from '@mandalika/api'
import { getKV } from '@mandalika/sync'
import { api } from '../../api'
import { RequisitionList } from './RequisitionList'
import { RequisitionDetail } from './RequisitionDetail'
import { RequisitionForm } from './RequisitionForm'
import {
  EMPTY_FORM, formFromRequisition, loadRequisition, loadRequisitions,
  type FlowDeps, type RequisitionFormState,
} from './requisitionFlow'
import { createRequisitionKeys } from './requisitionKeys'
import { cancelRequisitionById, discardPending, saveRequisition, submitRequisitionById } from './requisitionSave'
import type { RequisitionStatus } from './requisitionLabels'

interface Props {
  onClose: () => void
  /** Close this panel and open the existing receive panel (A08 step-up unchanged). */
  onOpenReceive: () => void
  isOnline: boolean
  /** The tablet's cached catalog (active products, pending sales applied). */
  products: readonly Product[]
  userId: string
  outletId: string
  /** Android Back: the panel sets a handler that returns true when it consumed the press (false = list, close the panel). */
  backRef: RefObject<(() => boolean) | null>
}

type View = { name: 'list' } | { name: 'detail'; id: string } | { name: 'form'; editing: StockRequisition | null }
type Step = { kind: string; message?: string }

const UNCONFIRMED_NOTICE = 'Ada permintaan yang belum terkonfirmasi. Simpan lagi untuk mengirim ulang; tidak akan tercatat dua kali.'

export function RequisitionPanel({ onClose, onOpenReceive, isOnline, products, userId, outletId, backRef }: Props) {
  const onlineRef = useRef(isOnline)
  useEffect(() => { onlineRef.current = isOnline })
  const deps = useMemo<FlowDeps>(() => ({ isOnline: () => onlineRef.current, api }), [])
  const keys = useMemo(() => createRequisitionKeys(getKV(), { userId, outletId }), [userId, outletId])

  const [view, setView] = useState<View>({ name: 'list' })
  const [filter, setFilter] = useState<RequisitionStatus | ''>('')
  const [reload, setReload] = useState(0)
  const [listed, setListed] = useState<{ key: string; rows: StockRequisition[]; error: string | null } | null>(null)
  const [pb, setPb] = useState<StockRequisition | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [retry, setRetry] = useState<(() => void) | null>(null)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState<RequisitionFormState>(EMPTY_FORM)
  const [confirmLeave, setConfirmLeave] = useState<(() => void) | null>(null)
  const inFlight = useRef(false)
  /** The PB whose detail is on screen; a response for any other id is dropped (L5). */
  const detailId = useRef<string | null>(null)
  /** The form as it was when opened, to tell unsaved changes from none. */
  const formBaseline = useRef(JSON.stringify(EMPTY_FORM))

  // The list is a function of (filter, reload): no state is set synchronously in the effect, and
  // "loading" is simply "the stored result is for another request".
  const listKey = `${filter}|${reload}`
  const listOpen = view.name === 'list'
  useEffect(() => {
    if (!listOpen) return
    let alive = true
    void loadRequisitions(deps, outletId, filter ? { status: filter } : {}).then((r) => {
      if (alive) setListed({ key: listKey, rows: r.kind === 'ok' ? r.value.data : [], error: r.kind === 'ok' ? null : r.message })
    })
    return () => { alive = false }
  }, [deps, outletId, filter, listKey, listOpen])
  const loading = listOpen && listed?.key !== listKey
  const rows = listed?.rows ?? []
  const listError = loading ? null : listed?.error ?? null
  const reloadList = () => setReload((n) => n + 1)

  const toList = () => { detailId.current = null; setView({ name: 'list' }); setMessage(null); setRetry(null); reloadList() }

  const showDetail = async (id: string, notice: string | null = null, again: (() => void) | null = null): Promise<void> => {
    detailId.current = id
    setView({ name: 'detail', id })
    setPb(null)
    setMessage(notice)
    setRetry(() => again)
    const r = await loadRequisition(deps, id)
    if (detailId.current !== id) return // the cashier moved on: a late answer must not repaint another screen
    if (r.kind === 'ok') setPb(r.value)
    else if (r.kind === 'gone') { detailId.current = null; setView({ name: 'list' }); setReload((n) => n + 1) }
    else { setMessage(r.message); setRetry(() => (r.kind === 'retry' ? () => void showDetail(id, notice, again) : null)) }
  }

  // Single-flight: a second tap in the same frame must not start a second write.
  const guarded = async (fn: () => Promise<void>) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try { await fn() } finally { inFlight.current = false; setBusy(false) }
  }

  const openForm = (editing: StockRequisition | null, next: RequisitionFormState, notice: string | null) => {
    formBaseline.current = JSON.stringify(next)
    setForm(next)
    setMessage(notice)
    setRetry(null)
    detailId.current = null
    setView({ name: 'form', editing })
  }
  const openNew = () => {
    const pending = keys.loadPendingCreate<RequisitionFormState>()
    openForm(null, pending?.form ?? EMPTY_FORM, pending?.sent ? UNCONFIRMED_NOTICE : null)
  }
  const openEdit = (p: StockRequisition) => openForm(p, formFromRequisition(p), null)

  const save = (andSubmit: boolean): Promise<void> => guarded(async () => {
    setMessage(null)
    setRetry(null)
    const editing = view.name === 'form' ? view.editing : null
    const out = await saveRequisition({ deps, keys, editing, form, andSubmit })
    if (out.kind === 'failed') {
      setMessage(out.message)
      setRetry(() => (out.failure === 'retry' ? () => void save(andSubmit) : null))
      return
    }
    formBaseline.current = JSON.stringify(EMPTY_FORM)
    setForm(EMPTY_FORM)
    if (out.kind === 'saved') return showDetail(out.pb.id)
    const submitAgain = out.step === 'submit' && out.failure === 'retry' ? () => void act((id) => submitRequisitionById(deps, keys, id), out.pb.id) : null
    return showDetail(out.pb.id, out.message, submitAgain)
  })

  const act = (run: (id: string) => Promise<Step>, id: string | undefined = pb?.id): Promise<void> => guarded(async () => {
    if (!id) return
    setMessage(null)
    setRetry(null)
    const r = await run(id)
    if (detailId.current !== id) return
    if (r.kind === 'ok') return showDetail(id)
    if (r.kind === 'stale') return showDetail(id, r.message ?? null)
    setMessage(r.message ?? null)
    setRetry(() => (r.kind === 'retry' ? () => void act(run, id) : null))
  })

  const discard = (): Promise<void> => guarded(async () => {
    const out = await discardPending(deps, keys)
    if (out.kind === 'unresolved') {
      setMessage(`${out.message} Isian belum dibuang.`)
      setRetry(() => (out.failure === 'retry' ? () => void discard() : null))
      return
    }
    formBaseline.current = JSON.stringify(EMPTY_FORM)
    setForm(EMPTY_FORM)
    setRetry(null)
    if (out.kind === 'draftExists') return showDetail(out.pb.id, out.message)
    setMessage(out.kind === 'cancelled' ? `Permintaan ${out.pb.number} yang belum terkonfirmasi sudah dibatalkan.` : null)
  })

  // Leaving a form with unsaved changes asks first; while a request is in flight navigation is ignored.
  const requestLeave = (go: () => void) => {
    if (inFlight.current) return
    const dirty = view.name === 'form' && JSON.stringify(form) !== formBaseline.current
    if (dirty) setConfirmLeave(() => go)
    else go()
  }
  useEffect(() => {
    backRef.current = () => {
      if (confirmLeave) { setConfirmLeave(null); return true }
      if (view.name === 'list') return false
      requestLeave(toList)
      return true
    }
    return () => { backRef.current = null }
  })

  const title = view.name === 'form' ? (view.editing ? 'Ubah Permintaan' : 'Buat Permintaan') : 'Permintaan Barang'
  const back = () => (view.name === 'list' ? requestLeave(onClose) : requestLeave(toList))

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button type="button" aria-label="Tutup" tabIndex={-1} className="absolute inset-0 bg-black/30" onClick={() => requestLeave(onClose)} />
      <div className="relative w-full max-w-lg bg-white h-full flex flex-col">
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <div className="flex items-center gap-2">
            {view.name !== 'list' && <button type="button" onClick={back} aria-label="Kembali" className="text-indigo-600 font-bold">←</button>}
            <h2 className="font-bold text-gray-900">{title}</h2>
          </div>
          <button type="button" onClick={() => requestLeave(onClose)} aria-label="Tutup panel" className="text-gray-400 text-xl leading-none">×</button>
        </div>
        <div className="flex-1 overflow-auto min-h-0">
          {view.name === 'list' && (
            <RequisitionList rows={rows} loading={loading} error={listError} filter={filter}
              onFilter={setFilter} onOpen={(id) => void showDetail(id)} onNew={openNew} onReload={reloadList} />
          )}
          {view.name === 'detail' && (pb ? (
            <RequisitionDetail pb={pb} busy={busy} message={message} onRetry={retry}
              onEdit={() => openEdit(pb)}
              onSubmit={() => void act((id) => submitRequisitionById(deps, keys, id))}
              onCancel={() => void act((id) => cancelRequisitionById(deps, keys, id))}
              onOpenReceive={onOpenReceive} />
          ) : (
            <div className="p-4">
              <p className="text-sm text-gray-400">{message ?? 'Memuat…'}</p>
              {message && retry && <button type="button" onClick={retry} className="mt-2 text-sm font-bold text-indigo-600">Coba Lagi</button>}
            </div>
          ))}
          {view.name === 'form' && (
            <RequisitionForm form={form} onChange={setForm} products={products} busy={busy} message={message} onRetry={retry} onMessage={setMessage}
              isEdit={view.editing !== null} onSave={(s) => void save(s)} onDiscard={() => void discard()} />
          )}
        </div>
        {confirmLeave && (
          <div className="absolute inset-0 z-10 bg-black/40 flex items-center justify-center p-4">
            <div role="alertdialog" aria-label="Buang perubahan?" className="bg-white rounded-xl p-4 w-full max-w-xs space-y-3">
              <p className="font-bold text-gray-900">Buang perubahan?</p>
              <p className="text-sm text-gray-500">Isian yang belum disimpan akan hilang.</p>
              <div className="flex gap-2">
                <button type="button" onClick={() => { const go = confirmLeave; setConfirmLeave(null); go() }} className="flex-1 bg-red-600 text-white rounded-lg py-2 text-sm font-bold">Buang</button>
                <button type="button" onClick={() => setConfirmLeave(null)} className="flex-1 border rounded-lg py-2 text-sm font-bold text-gray-600">Tetap di sini</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
