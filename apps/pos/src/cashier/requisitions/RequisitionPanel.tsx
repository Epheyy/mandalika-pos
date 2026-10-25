/**
 * Permintaan Barang (PB): the cashier raises, submits, cancels and tracks stock requests for this
 * outlet. Online-only: every call goes through requisitionFlow (never the outbox). A full-height
 * slide-over with an in-screen list / detail / form swap (no router). The warehouse actions
 * (approve, reject, fulfil) are never rendered or called here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Product, StockRequisition } from '@mandalika/api'
import { getKV } from '@mandalika/sync'
import { api } from '../../api'
import { RequisitionList } from './RequisitionList'
import { RequisitionDetail } from './RequisitionDetail'
import { RequisitionForm } from './RequisitionForm'
import {
  EMPTY_FORM, cancelRequisition, formFromRequisition, loadRequisition, loadRequisitions,
  type FlowDeps, type RequisitionFormState,
} from './requisitionFlow'
import { createRequisitionKeys } from './requisitionKeys'
import { saveRequisition, submitRequisitionById } from './requisitionSave'
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
}

type View = { name: 'list' } | { name: 'detail'; id: string } | { name: 'form'; editing: StockRequisition | null }

export function RequisitionPanel({ onClose, onOpenReceive, isOnline, products, userId, outletId }: Props) {
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
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState<RequisitionFormState>(EMPTY_FORM)
  const inFlight = useRef(false)

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

  const showDetail = useCallback(async (id: string, notice: string | null = null) => {
    setView({ name: 'detail', id })
    setPb(null)
    setMessage(notice)
    const r = await loadRequisition(deps, id)
    if (r.kind === 'ok') setPb(r.value)
    else if (r.kind === 'gone') { setView({ name: 'list' }); reloadList() }
    else setMessage(r.message)
  }, [deps])

  // Single-flight: a second tap in the same frame must not start a second write.
  const guarded = async (fn: () => Promise<void>) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try { await fn() } finally { inFlight.current = false; setBusy(false) }
  }

  const openNew = () => {
    const pending = keys.loadPendingCreate<RequisitionFormState>()
    setForm(pending?.form ?? EMPTY_FORM)
    setMessage(null)
    setView({ name: 'form', editing: null })
  }
  const openEdit = (p: StockRequisition) => {
    setForm(formFromRequisition(p))
    setMessage(null)
    setView({ name: 'form', editing: p })
  }

  const save = (andSubmit: boolean) => guarded(async () => {
    setMessage(null)
    const editing = view.name === 'form' ? view.editing : null
    const out = await saveRequisition({ deps, keys, editing, form, andSubmit })
    if (out.kind === 'failed') return setMessage(out.message)
    setForm(EMPTY_FORM)
    await showDetail(out.pb.id, out.kind === 'draftOnly' ? `Draf tersimpan, tetapi belum diajukan. ${out.message}` : null)
  })

  const act = (run: (id: string) => Promise<{ kind: string; message?: string }>) => guarded(async () => {
    if (!pb) return
    setMessage(null)
    const r = await run(pb.id)
    if (r.kind === 'ok') return showDetail(pb.id)
    if (r.kind === 'stale') return showDetail(pb.id, r.message ?? null)
    setMessage(r.message ?? null)
  })

  const title = view.name === 'form' ? (view.editing ? 'Ubah Permintaan' : 'Buat Permintaan') : 'Permintaan Barang'
  const back = () => { if (view.name === 'list') onClose(); else { setView({ name: 'list' }); reloadList() } }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button type="button" aria-label="Tutup" tabIndex={-1} className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-white h-full flex flex-col">
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <div className="flex items-center gap-2">
            {view.name !== 'list' && <button type="button" onClick={back} aria-label="Kembali" className="text-indigo-600 font-bold">←</button>}
            <h2 className="font-bold text-gray-900">{title}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Tutup panel" className="text-gray-400 text-xl leading-none">×</button>
        </div>
        <div className="flex-1 overflow-auto min-h-0">
          {view.name === 'list' && (
            <RequisitionList rows={rows} loading={loading} error={listError} filter={filter}
              onFilter={setFilter} onOpen={(id) => void showDetail(id)} onNew={openNew} onReload={reloadList} />
          )}
          {view.name === 'detail' && (pb ? (
            <RequisitionDetail pb={pb} busy={busy} message={message}
              onEdit={() => openEdit(pb)}
              onSubmit={() => void act((id) => submitRequisitionById(deps, keys, id))}
              onCancel={() => void act((id) => cancelRequisition(deps, id, keys.keyFor('cancel', id, 'cancel')))}
              onOpenReceive={onOpenReceive} />
          ) : <p className="p-4 text-sm text-gray-400">{message ?? 'Memuat…'}</p>)}
          {view.name === 'form' && (
            <RequisitionForm form={form} onChange={setForm} products={products} busy={busy} message={message} onMessage={setMessage}
              isEdit={view.editing !== null} onSave={(s) => void save(s)}
              onDiscard={() => { void keys.clearPendingCreate(); setForm(EMPTY_FORM); setMessage(null) }} />
          )}
        </div>
      </div>
    </div>
  )
}
