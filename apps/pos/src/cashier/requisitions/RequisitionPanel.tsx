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
import { reportErrors } from '../../lib/errorReporter'
import { RequisitionList } from './RequisitionList'
import { RequisitionDetail } from './RequisitionDetail'
import { RequisitionForm } from './RequisitionForm'
import {
  EMPTY_FORM, PERMANENT_FAILURES, formFromRequisition, loadRequisition, loadRequisitions,
  type FlowKind,
  type FlowDeps, type RequisitionFormState,
} from './requisitionFlow'
import { createRequisitionKeys } from './requisitionKeys'
import {
  cancelRequisitionById, discardPending, forceDiscardPending, resolvePendingCreate, saveRequisition, submitRequisitionById,
} from './requisitionSave'
import type { RequisitionStatus } from './requisitionLabels'
import { Sheet } from '../../components/ui/Sheet'
import { Button } from '../../components/ui/Button'

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
interface Confirm { title: string; body: string; label: string; action: () => void }

const UNCONFIRMED_NOTICE = 'Ada permintaan yang belum terkonfirmasi. Simpan lagi untuk mengirim ulang; tidak akan tercatat dua kali.'
const STORAGE_NOTICE = 'Penyimpanan lokal gagal; jangan tutup aplikasi sampai permintaan ini tersimpan.'

export function RequisitionPanel({ onClose, onOpenReceive, isOnline, products, userId, outletId, backRef }: Props) {
  const onlineRef = useRef(isOnline)
  useEffect(() => { onlineRef.current = isOnline })
  const deps = useMemo<FlowDeps>(() => ({ isOnline: () => onlineRef.current, api }), [])
  const keys = useMemo(() => createRequisitionKeys(getKV(), { userId, outletId }, (what, err) => {
    void reportErrors([{ source: 'runtime', kind: 'requisition_storage', action: 'Simpan permintaan barang', message: `${what}: ${err instanceof Error ? err.message : 'gagal'}` }])
  }), [userId, outletId])

  // An unconfirmed create left by an earlier session is resolved as soon as the panel opens online (M2a),
  // before the cashier can touch anything: busy is passed to the list and the form, so taps wait until it is settled.
  const [resolvingAtOpen] = useState(() => isOnline && keys.loadPendingCreate()?.sent === true)

  const [view, setView] = useState<View>({ name: 'list' })
  const [filter, setFilter] = useState<RequisitionStatus | ''>('')
  const [reload, setReload] = useState(0)
  const [listed, setListed] = useState<{ key: string; rows: StockRequisition[]; error: string | null } | null>(null)
  const [listNotice, setListNotice] = useState<string | null>(null)
  const [pb, setPb] = useState<StockRequisition | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [retry, setRetry] = useState<(() => void) | null>(null)
  const [busy, setBusy] = useState(resolvingAtOpen)
  const [form, setForm] = useState<RequisitionFormState>(EMPTY_FORM)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  /** A pending create is stuck on a permanent cause (403, 404, 413 ...): offer the forced discard. */
  const [stuck, setStuck] = useState(false)
  const inFlight = useRef(resolvingAtOpen)
  /** The PB whose detail is on screen; a response for any other id is dropped (L5). */
  const detailId = useRef<string | null>(null)
  /** The form as it was when opened, to tell unsaved changes from none. */
  const formBaseline = useRef(JSON.stringify(EMPTY_FORM))
  /** The latest form and edited draft, so a "Coba Lagi" captured earlier never re-sends stale content (L-b). */
  const formRef = useRef(form)
  const editingRef = useRef<StockRequisition | null>(null)
  useEffect(() => {
    formRef.current = form
    editingRef.current = view.name === 'form' ? view.editing : null
  })

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

  const resetForm = () => { formBaseline.current = JSON.stringify(EMPTY_FORM); setForm(EMPTY_FORM); setStuck(false) }
  /** Offer the forced discard only for a permanent failure while an unconfirmed create is actually pending. */
  const noteFailure = (failure: FlowKind) => setStuck(PERMANENT_FAILURES.has(failure) && keys.loadPendingCreate()?.sent === true)
  const toList = (notice: string | null = null) => {
    detailId.current = null
    setView({ name: 'list' })
    setMessage(null)
    setRetry(null)
    setListNotice(notice)
    reloadList()
  }

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

  useEffect(() => {
    if (!resolvingAtOpen) return
    let alive = true
    void resolvePendingCreate(deps, keys).then((res) => {
      if (!alive) return
      if (res.kind === 'resolved') void showDetail(res.pb.id, `Draf ${res.pb.number} tersimpan dari percobaan sebelumnya.`)
      else if (res.kind === 'maybeSaved') toList(res.message)
      else if (res.kind === 'refused') toList(`Permintaan sebelumnya ditolak server dan dibuang: ${res.message}`)
      else if (res.kind === 'blocked') noteFailure(res.failure)
    }).finally(() => { inFlight.current = false; setBusy(false) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once at open; showDetail/toList only set state
  }, [resolvingAtOpen, deps, keys])

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
    setListNotice(null)
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
    const out = await saveRequisition({ deps, keys, editing: editingRef.current, form: formRef.current, andSubmit })
    const storage = keys.storageFailed() ? ` ${STORAGE_NOTICE}` : ''
    if (out.kind === 'failed') {
      if (out.failure === 'keyConflict' && !editingRef.current) { resetForm(); return toList(out.message) } // a create: a PB may already exist, look at the list
      noteFailure(out.failure)
      // (an edit that hit a key conflict stays open: the message says "Simpan lagi" and the next save uses a new key)
      setMessage(out.message + storage)
      setRetry(() => (out.failure === 'retry' ? () => void save(andSubmit) : null))
      return
    }
    if (out.kind === 'draftOnly' && out.step === 'update') {
      // The PB exists but the edit was not applied: keep the cashier's content and edit THAT PB (L-c).
      formBaseline.current = JSON.stringify(formFromRequisition(out.pb))
      detailId.current = null
      setMessage(out.message + storage)
      setRetry(null)
      setView({ name: 'form', editing: out.pb })
      return
    }
    resetForm()
    if (out.kind === 'saved') return showDetail(out.pb.id, storage ? STORAGE_NOTICE : null)
    if (out.kind === 'foundChanged') return showDetail(out.pb.id, out.message)
    const submitAgain = out.failure === 'retry' ? () => void act((id) => submitRequisitionById(deps, keys, id), out.pb.id) : null
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
      noteFailure(out.failure)
      setMessage(`${out.message} Isian belum dibuang.`)
      setRetry(() => (out.failure === 'retry' ? () => void discard() : null))
      return
    }
    resetForm()
    setRetry(null)
    if (out.kind === 'maybeSaved') return toList(out.message)
    if (out.kind === 'draftExists') return showDetail(out.pb.id, out.message)
    setMessage(out.kind === 'cancelled' ? `Permintaan ${out.pb.number} yang belum terkonfirmasi sudah dibatalkan.` : null)
  })
  const askDiscard = () => setConfirm({
    title: 'Buang isian?',
    body: 'Jika permintaan ini sempat terkirim ke server, permintaan itu akan dibatalkan.',
    label: 'Buang',
    action: () => void discard(),
  })

  const forceDiscard = (): Promise<void> => guarded(async () => {
    await forceDiscardPending(keys)
    resetForm()
    toList('Isian dibuang tanpa dicek. Permintaan itu mungkin sudah tersimpan di server: periksa daftar permintaan.')
  })
  const askForceDiscard = () => setConfirm({
    title: 'Buang tanpa cek?',
    body: 'Permintaan ini mungkin sudah tersimpan di server. Membuang di sini TIDAK membatalkannya. Periksa daftar permintaan dulu.',
    label: 'Buang tanpa cek',
    action: () => void forceDiscard(),
  })

  // Leaving a form with unsaved changes asks first; while a request is in flight navigation is ignored.
  const requestLeave = (go: () => void) => {
    if (inFlight.current) return
    const dirty = view.name === 'form' && JSON.stringify(form) !== formBaseline.current
    if (dirty) setConfirm({ title: 'Buang perubahan?', body: 'Isian yang belum disimpan akan hilang.', label: 'Buang', action: go })
    else go()
  }
  const goList = () => toList()
  useEffect(() => {
    backRef.current = () => {
      if (confirm) { setConfirm(null); return true }
      if (view.name === 'list') return false
      requestLeave(goList)
      return true
    }
    return () => { backRef.current = null }
  })

  const title = view.name === 'form' ? (view.editing ? 'Ubah Permintaan' : 'Buat Permintaan') : 'Permintaan Barang'
  const back = () => (view.name === 'list' ? requestLeave(onClose) : requestLeave(goList))

  return (
    <Sheet open variant="side" onClose={() => { if (confirm) setConfirm(null); else requestLeave(onClose) }} panelClassName="flex flex-col">
        <div className="py-1 pl-4 pr-2 border-b border-paper-2 flex items-center justify-between">
          <div className="flex items-center gap-1">
            {view.name !== 'list' && <button type="button" onClick={back} aria-label="Kembali" className="press inline-flex h-11 w-11 items-center justify-center rounded-control font-bold text-brand-strong active:bg-paper-1">←</button>}
            <h2 className="text-lg font-bold text-ink-900">{title}</h2>
          </div>
          <button type="button" onClick={() => requestLeave(onClose)} aria-label="Tutup panel" className="press inline-flex h-11 w-11 items-center justify-center rounded-control text-xl leading-none text-ink-700 active:bg-paper-1">×</button>
        </div>
        <div className="flex-1 overflow-auto min-h-0">
          {view.name === 'list' && (
            <RequisitionList rows={rows} loading={loading} error={listError} notice={listNotice} busy={busy} filter={filter}
              onFilter={setFilter} onOpen={(id) => { setListNotice(null); void showDetail(id) }} onNew={openNew} onReload={reloadList} />
          )}
          {view.name === 'detail' && (pb ? (
            <RequisitionDetail pb={pb} busy={busy} message={message} onRetry={retry}
              onEdit={() => openEdit(pb)}
              onSubmit={() => void act((id) => submitRequisitionById(deps, keys, id))}
              onCancel={() => void act((id) => cancelRequisitionById(deps, keys, id))}
              onOpenReceive={onOpenReceive} />
          ) : (
            <div className="p-4">
              <p className="text-sm text-ink-500">{message ?? 'Memuat…'}</p>
              {message && retry && <Button variant="secondary" onClick={retry} className="mt-2">Coba Lagi</Button>}
            </div>
          ))}
          {view.name === 'form' && (
            <RequisitionForm form={form} onChange={setForm} products={products} busy={busy} message={message} onRetry={retry} onMessage={setMessage} onForceDiscard={stuck ? askForceDiscard : null}
              isEdit={view.editing !== null} onSave={(s) => void save(s)} onDiscard={askDiscard} />
          )}
        </div>
        {confirm && (
          <div className="absolute inset-0 z-10 bg-ink-900/40 rounded-l-panel flex items-center justify-center p-4">
            <div role="alertdialog" aria-label={confirm.title} className="surface-solid rounded-panel p-4 w-full max-w-xs space-y-3">
              <p className="font-bold text-ink-900">{confirm.title}</p>
              <p className="text-sm text-ink-700">{confirm.body}</p>
              <div className="flex gap-2">
                <Button variant="danger" onClick={() => { const go = confirm.action; setConfirm(null); go() }} className="flex-1">{confirm.label}</Button>
                <Button variant="secondary" onClick={() => setConfirm(null)} className="flex-1">Tetap di sini</Button>
              </div>
            </div>
          </div>
        )}
    </Sheet>
  )
}
