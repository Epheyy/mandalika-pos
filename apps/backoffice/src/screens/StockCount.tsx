import { useMemo, useRef, useState } from 'react'
import { fetchAllPages, type AppSettings, type StockCountSubmitInput, type StockCount, type StockCountItem, type Outlet, type Warehouse, type ListResult } from '@mandalika/api'
import { format, parseISO } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import { Plus, Play, CheckCircle, Send, XCircle, ChevronDown, ChevronUp, ClipboardList } from 'lucide-react'
import { api, authStore } from '../api'
import { activeProducts, productCatalogue } from '../lib/productCatalogue'
import { useCachedList } from '../hooks/useCachedList'
import { localDay } from '../lib/businessDay'
import { useOutlet } from '../outlet'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { TableSkeleton } from '../components/Skeleton'
import { completeAfterFlush, createLineSaver, type PendingEdits } from '../lib/pendingEdits'
import { exportToCSV, exportToXLSX, buildExportName } from '../lib/csvUtils'
import { ImportExportMenu } from '../ui/ImportExportMenu'
import { Button } from '../ui/Button'
import { Input, Select, Textarea, fieldClass } from '../ui/Field'
import { Modal } from '../ui/Modal'
import { Card } from '../ui/Card'
import { Badge } from '../ui/Badge'
import { IconButton } from '../ui/IconButton'
import { EmptyState } from '../ui/EmptyState'
import { PageHeader } from '../ui/PageHeader'
import { Pagination } from '../ui/Pagination'
import { countStatusLabel, countStatusTone, isApprovalRequired, varianceLines } from '../lib/inventoryApproval'
import { useConfirm } from '../ui/ConfirmDialog'
import { SubmitCountModal } from './approvals/SubmitCountModal'
import { notifyApprovalsChanged } from './approvals/useApprovalCount'
import { CountCsvPanel } from './stockcount/CountCsvPanel'
import { countErrorMessage, freezeSummary, newestFirst, withCountScope } from './stockcount/countScope'
import { cancelCountConfirm, completeCountConfirm, lineDifference, startCountConfirm, summarizeCount } from './stockcount/countConfirm'


const tone = countStatusTone
const label = countStatusLabel
const locKind = (sc: StockCount) => (sc.warehouseId ? 'Gudang' : 'Outlet')

const lineKey = (it: StockCountItem) => `${it.productId}|${it.variantSize}`

export default function StockCount() {
  const { outletId, outlets: ctxOutlets, isAdmin } = useOutlet()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const scq = usePolledQuery<ListResult<StockCount>>(() => api.listStockCounts(page, pageSize), [outletId, page, pageSize])
  // The whole product list is read once per outlet scope (shared cache), not on the 12 s poll.
  const pq = useCachedList(productCatalogue)
  const ouq = usePolledQuery<Outlet[]>(() => api.listOutlets(), [])
  const wq = usePolledQuery<Warehouse[]>(() => api.listWarehouses(), [])
  const setq = usePolledQuery<AppSettings>(() => api.getAppSettings(), [], 300000)
  const approvalOn = setq.data?.inventoryApprovalRequired === true
  const [submitFor, setSubmitFor] = useState<StockCount | null>(null)
  const ask = useConfirm()
  const stockCounts = useMemo(() => newestFirst(scq.data?.data ?? []), [scq.data])
  const scTotal = scq.data?.meta?.total ?? 0
  const scTotalPages = Math.max(1, Math.ceil(scTotal / pageSize))
  const products = useMemo(() => activeProducts(pq.data) ?? [], [pq.data])
  const outlets = ctxOutlets.length ? ctxOutlets : ouq.data ?? []
  const warehouses = wq.data ?? []

  const [expanded, setExpanded] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [pageErr, setPageErr] = useState<string | null>(null)
  // Unsaved local edits. The ref mirrors the state so async saves read the latest value.
  const [edits, setEdits] = useState<PendingEdits>({})
  const editsRef = useRef<PendingEdits>({})
  const updateEdits = (fn: (d: PendingEdits) => PendingEdits) => {
    editsRef.current = fn(editsRef.current)
    setEdits(editsRef.current)
  }
  // Latest list + refetch for the saver, which outlives any single render.
  const countsRef = useRef<StockCount[]>([])
  countsRef.current = stockCounts
  const refetchRef = useRef(scq.refetch)
  refetchRef.current = scq.refetch
  // Every call about an existing count runs under that count's own outlet: under "Semua outlet" the header sends
  // none, and the server answers "not found" for an outlet count it cannot place.
  const onCount = <T,>(sc: StockCount, fn: () => Promise<T>): Promise<T> => withCountScope(authStore, sc, fn)
  const lineSaver = useRef(
    createLineSaver({
      getEdits: () => editsRef.current,
      setEdits: updateEdits,
      send: async (scId, key, value) => {
        const owner = countsRef.current.find((c) => c.id === scId)
        const line = owner?.items.find((i) => lineKey(i) === key)
        if (!owner || !line) throw new Error('Baris tidak ditemukan. Muat ulang halaman.')
        await onCount(owner, () => api.updateStockCount(scId, { items: [{ ...line, actualQty: value }] }))
      },
      refresh: () => refetchRef.current(),
    }),
  ).current
  const [form, setForm] = useState({
    name: '',
    locationKey: '',
    plannedDate: localDay(),
    notes: '',
  })

  // Local edits only apply to a running count; finished counts show stored values.
  const itemsFor = (sc: StockCount) =>
    sc.status !== 'in_progress'
      ? sc.items
      : sc.items.map((it) => {
          const e = edits[sc.id]?.[lineKey(it)]
          return e === undefined ? it : { ...it, actualQty: e }
        })
  const dropEdits = (scId: string) =>
    updateEdits((d) => {
      if (!(scId in d)) return d
      const rest = { ...d }
      delete rest[scId]
      return rest
    })
  // Lines with an unsaved edit (read from the ref: never stale inside async work).
  const pendingLines = (sc: StockCount) =>
    sc.items.filter((it) => editsRef.current[sc.id]?.[lineKey(it)] !== undefined)
  const fail = (e: unknown, fallback: string) => setPageErr(countErrorMessage(e, fallback))

  const createSC = async () => {
    if (!form.name.trim()) return setErr('Nama wajib diisi')
    if (isAdmin && !form.locationKey) return setErr('Pilih lokasi')
    const [kind, locId] = isAdmin ? form.locationKey.split(':') : ['o', null]
    setBusy(true)
    setErr(null)
    const prev = authStore.outletId
    try {
      if (kind === 'w' && locId) {
        // Warehouse count: snapshot from warehouse stock, no authStore switch.
        const wrows = await api.getWarehouseStock(locId)
        const items: StockCountItem[] = wrows.map((r) => ({
          productId: r.productId,
          productName: r.productName,
          variantSize: r.variantSize,
          sku: r.sku ?? '',
          frozenQty: r.stock,
        }))
        await api.createStockCount({
          name: form.name.trim(),
          warehouseId: locId,
          plannedDate: form.plannedDate,
          notes: form.notes.trim(),
          items,
        })
      } else {
        // Outlet count: snapshot from products, switch authStore for admins. The product list is keyed by the
        // header outlet and carries that outlet's stock, so switch first, then read it fresh (not from the shared cache).
        if (isAdmin && locId) authStore.outletId = locId
        const frozen = activeProducts(await productCatalogue.get({ force: true })) ?? []
        const items: StockCountItem[] = frozen.flatMap((p) =>
          p.variants.map((v) => ({
            productId: p.id,
            productName: p.name,
            variantSize: v.size,
            sku: v.sku,
            frozenQty: v.stock,
          })),
        )
        await api.createStockCount({
          name: form.name.trim(),
          outletId: isAdmin ? locId ?? '' : '',
          plannedDate: form.plannedDate,
          notes: form.notes.trim(),
          items,
        })
      }
      setOpen(false)
      setForm({ name: '', locationKey: '', plannedDate: localDay(), notes: '' })
      await scq.refetch()
    } catch (e: unknown) {
      setErr(countErrorMessage(e, 'Gagal membuat opname.'))
    } finally {
      authStore.outletId = prev
      setBusy(false)
    }
  }

  const start = async (sc: StockCount) => {
    if (!(await ask(startCountConfirm(sc.name))).confirmed) return
    setPageErr(null)
    try {
      await onCount(sc, () => api.updateStockCount(sc.id, { status: 'in_progress' }))
      setExpanded(sc.id)
    } catch (e) {
      fail(e, 'Gagal memulai opname.')
    }
    await scq.refetch()
  }
  const cancel = async (sc: StockCount) => {
    if (!(await ask(cancelCountConfirm(sc.name, sc.status))).confirmed) return
    setPageErr(null)
    try {
      await onCount(sc, () => api.updateStockCount(sc.id, { status: 'cancelled' }))
      dropEdits(sc.id)
    } catch (e) {
      fail(e, 'Gagal membatalkan opname.')
    }
    await scq.refetch()
  }
  const setQty = (sc: StockCount, it: StockCountItem, raw: string) => {
    const qty = raw.trim() === '' ? null : Math.max(0, parseInt(raw, 10) || 0)
    updateEdits((d) => ({ ...d, [sc.id]: { ...(d[sc.id] ?? {}), [lineKey(it)]: qty } }))
  }
  // Save one line on blur/Enter so the server captures the stock at count time. One
  // request per line at a time (see createLineSaver); resolves true if saved.
  const saveLine = async (sc: StockCount, it: StockCountItem): Promise<boolean> => {
    try {
      await lineSaver.save(sc.id, lineKey(it))
      setPageErr(null)
      return true
    } catch (e) {
      fail(e, 'Gagal menyimpan hitungan.')
      return false
    }
  }
  // Save every pending line (each through its own queue); true only if none is left pending.
  const flushPending = async (sc: StockCount): Promise<boolean> => {
    const results = await Promise.all(pendingLines(sc).map((it) => saveLine(sc, it)))
    await scq.refetch()
    return !results.includes(false) && pendingLines(sc).length === 0
  }
  const saveProgress = async (sc: StockCount) => {
    setActiveId(sc.id)
    setPageErr(null)
    try {
      await flushPending(sc)
    } finally {
      setActiveId(null)
    }
  }
  const complete = async (sc: StockCount) => {
    setActiveId(sc.id)
    setPageErr(null)
    try {
      // Save pending lines first: saving re-captures each line's baseline from live stock, so only the saved count
      // tells the net the server will apply. Saving moves no stock, so a Batal after it is harmless.
      if (!(await flushPending(sc))) return setPageErr((m) => m ?? 'Ada hitungan yang belum tersimpan. Periksa lalu coba lagi.')
      const saved = await onCount(sc, () => api.getStockCount(sc.id))
      const { confirmed } = await ask(completeCountConfirm(saved.name, summarizeCount(saved.items)))
      if (!confirmed) return
      // Nothing is pending now; the flush stays as the guard it was.
      const done = await completeAfterFlush(
        () => flushPending(sc),
        async () => {
          await onCount(sc, () => api.completeStockCount(sc.id))
          dropEdits(sc.id)
          await scq.refetch()
        },
      )
      if (!done) setPageErr((m) => m ?? 'Ada hitungan yang belum tersimpan. Periksa lalu coba lagi.')
    } catch (e) {
      if (isApprovalRequired(e)) {
        setPageErr('Persetujuan stok wajib. Gunakan "Ajukan Persetujuan".')
        await setq.refetch()
      } else fail(e, 'Gagal menyelesaikan opname.')
      await scq.refetch()
    } finally {
      setActiveId(null)
    }
  }

  // Opens the approval form after saving pending lines; a count with no variance is completed by the server.
  const openSubmit = async (sc: StockCount) => {
    setActiveId(sc.id)
    setPageErr(null)
    try {
      const ok = await flushPending(sc)
      if (!ok) return setPageErr((m) => m ?? 'Ada hitungan yang belum tersimpan. Periksa lalu coba lagi.')
      setSubmitFor(await onCount(sc, () => api.getStockCount(sc.id)))
    } catch (e) {
      fail(e, 'Gagal memuat opname.')
    } finally {
      setActiveId(null)
    }
  }
  const submitCount = async (input: StockCountSubmitInput, key: string) => {
    if (!submitFor) return
    await onCount(submitFor, () => api.submitStockCount(submitFor.id, input, key))
    dropEdits(submitFor.id)
    setSubmitFor(null)
    await scq.refetch()
    notifyApprovalsChanged()
  }

  const exportStockCounts = async (fmt: 'csv' | 'xlsx') => {
    const all = await fetchAllPages((page, limit) => api.listStockCounts(page, limit))
    const exportRows = all.map((sc) => ({
      Nama: sc.name,
      Lokasi: locName(sc),
      'Tipe Lokasi': locKind(sc),
      Status: label(sc.status),
      'Tanggal Rencana': sc.plannedDate ?? '',
      Selesai: sc.completedAt ? sc.completedAt.slice(0, 10) : '',
      'Jumlah Item': sc.items.length,
    }))
    const scope = outletId ? (ctxOutlets.find((o) => o.id === outletId)?.name ?? null) : 'semua-outlet'
    const name = buildExportName('opname-produk', [scope])
    if (fmt === 'csv') exportToCSV(exportRows, name)
    else exportToXLSX(exportRows, name)
  }

  const outletName = (oid: string) => outlets.find((o) => o.id === oid)?.name || oid
  const locName = (sc: StockCount) =>
    sc.warehouseId
      ? warehouses.find((w) => w.id === sc.warehouseId)?.name ?? 'Gudang'
      : outletName(sc.outletId ?? '')

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="Opname Produk"
        subtitle="Selisih hitungan diterapkan ke stok saat ini. Transaksi tetap berjalan."
        actions={
          <>
            <ImportExportMenu
              onExport={(fmt) => void exportStockCounts(fmt)}
              exportDisabled={scTotal === 0}
            />
            <Button icon={<Plus className="w-4 h-4" />} onClick={() => { setErr(null); setOpen(true) }}>
              Tambah opname
            </Button>
          </>
        }
      />

      {pageErr && (
        <div role="alert" className="bg-red-50 text-red-700 rounded-xl px-4 py-3 text-sm flex justify-between gap-3">
          <span>{pageErr}</span>
          <button type="button" className="font-bold" onClick={() => setPageErr(null)}>Tutup</button>
        </div>
      )}

      <div className="space-y-3">
        {scq.loading ? (
          <TableSkeleton />
        ) : stockCounts.length === 0 ? (
          <Card>
            <EmptyState icon={<ClipboardList />} title="Belum ada opname produk" />
          </Card>
        ) : (
          stockCounts.map((sc) => {
            const items = itemsFor(sc)
            return (
              <Card key={sc.id} className="overflow-clip">
                <div className="px-5 py-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-gold-50 rounded-xl flex items-center justify-center">
                      <ClipboardList className="w-5 h-5 text-gold-600" />
                    </div>
                    <div>
                      <p className="font-bold text-gray-900">{sc.name}</p>
                      <p className="text-xs text-gray-400">
                        <span className="font-bold text-gray-500">{locKind(sc)}</span> {locName(sc)} · {sc.plannedDate ? format(parseISO(sc.plannedDate), 'dd MMM yyyy', { locale: idLocale }) : '—'} · {items.length} item
                        {sc.status === 'in_progress' && ` · ${items.filter((i) => i.actualQty != null).length}/${items.length} dihitung`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={tone(sc.status)}>{label(sc.status)}</Badge>
                    {sc.status === 'planned' && (
                      <Button size="sm" icon={<Play className="w-3 h-3" />} onClick={() => start(sc)}>
                        Mulai
                      </Button>
                    )}
                    {sc.status === 'in_progress' && (
                      <>
                        <CountCsvPanel count={sc} blocked={pendingLines(sc).length > 0} onApplied={() => { dropEdits(sc.id); void scq.refetch() }} />
                        <Button variant="secondary" size="sm" loading={activeId === sc.id} onClick={() => saveProgress(sc)}>
                          Simpan
                        </Button>
                        {approvalOn ? (
                          <Button size="sm" icon={<Send className="w-3 h-3" />} disabled={activeId === sc.id} onClick={() => openSubmit(sc)}>
                            Ajukan Persetujuan
                          </Button>
                        ) : (
                          <Button size="sm" icon={<CheckCircle className="w-3 h-3" />} disabled={activeId === sc.id} onClick={() => complete(sc)}>
                            Selesai
                          </Button>
                        )}
                      </>
                    )}
                    {['planned', 'in_progress'].includes(sc.status) && (
                      <IconButton tone="danger" aria-label={`Batalkan opname ${sc.name}`} onClick={() => cancel(sc)}>
                        <XCircle className="w-4 h-4" />
                      </IconButton>
                    )}
                    <IconButton
                      label={expanded === sc.id ? `Tutup rincian ${sc.name}` : `Buka rincian ${sc.name}`}
                      aria-expanded={expanded === sc.id}
                      onClick={() => setExpanded(expanded === sc.id ? null : sc.id)}
                    >
                      {expanded === sc.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </IconButton>
                  </div>
                </div>
                {sc.rejectedNote && sc.status === 'in_progress' && (
                  <p role="alert" className="mx-5 mb-3 rounded-xl bg-red-50 px-4 py-2 text-sm font-bold text-red-700">
                    Ditolak: {sc.rejectedNote}
                  </p>
                )}
                {sc.status === 'pending_approval' && (
                  <p className="mx-5 mb-3 text-xs text-amber-700">
                    Diajukan {sc.submittedAt ? format(parseISO(sc.submittedAt), 'dd MMM yyyy HH:mm') : ''} oleh {sc.submittedByName ?? sc.submittedBy?.slice(0, 8) ?? '-'}. Menunggu persetujuan, tidak bisa diubah.
                  </p>
                )}
                {sc.status === 'completed' && sc.approvedBy && (
                  <p className="mx-5 mb-3 text-xs text-gray-500">
                    Disetujui {sc.approvedAt ? format(parseISO(sc.approvedAt), 'dd MMM yyyy HH:mm') : ''} oleh {sc.approvedByName ?? sc.approvedBy.slice(0, 8)}.
                  </p>
                )}
                {expanded === sc.id && (
                  <div className="border-t border-gray-100 overflow-x-auto">
                    <table className="w-full">
                      <thead className="sticky top-0 bg-gray-50">
                        <tr>
                          {['Produk', 'Varian', 'SKU', 'Stok sistem', 'Stok dihitung', 'Selisih', ...(sc.status === 'completed' ? ['Stok Sebelum → Sesudah'] : [])].map((h) => (
                            <th key={h} className="text-left px-4 py-2 text-xs font-black text-gray-400 uppercase">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {items.map((it) => (
                          <tr key={`${it.productId}-${it.variantSize}`} className="hover:bg-gray-50">
                            <td className="px-4 py-2 text-sm font-bold text-gray-900">{it.productName}</td>
                            <td className="px-4 py-2 text-xs text-gray-600">{it.variantSize}</td>
                            <td className="px-4 py-2 text-xs text-gray-400 font-mono">{it.sku}</td>
                            <td className="px-4 py-2 text-sm font-bold text-gold-700">{it.frozenQty}</td>
                            <td className="px-4 py-2">
                              {sc.status === 'in_progress' ? (
                                <div className="flex items-center gap-2">
                                  <input type="number" min={0} value={it.actualQty ?? ''} onChange={(e) => setQty(sc, it, e.target.value)} onBlur={() => void saveLine(sc, it)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} aria-label={`Jumlah dihitung ${it.productName}${it.variantSize ? ` ${it.variantSize}` : ''}`} className={`${fieldClass} w-20 px-2 py-1 text-center`} />
                                  {it.countedAt && edits[sc.id]?.[lineKey(it)] === undefined && (
                                    <span className="text-[10px] text-gray-400">dihitung {format(parseISO(it.countedAt), 'HH:mm')}</span>
                                  )}
                                </div>
                              ) : (
                                <span className="text-sm font-bold text-gray-900">{it.actualQty ?? '—'}</span>
                              )}
                            </td>
                            <td className="px-4 py-2">
                              {(() => {
                                const diff = lineDifference(it)
                                return diff != null ? (
                                  <span className={`text-sm font-black ${diff > 0 ? 'text-green-600' : diff < 0 ? 'text-red-600' : 'text-gray-400'}`}>
                                    {diff > 0 ? '+' : ''}{diff}
                                  </span>
                                ) : '—'
                              })()}
                            </td>
                            {sc.status === 'completed' && (
                              <td className="px-4 py-2 text-xs text-gray-600">
                                {it.stockBefore != null && it.stockAfter != null ? `${it.stockBefore} → ${it.stockAfter}` : '—'}
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            )
          })
        )}
      </div>

      <Pagination
        page={page}
        totalPages={scTotalPages}
        total={scTotal}
        onChange={setPage}
        pageSize={pageSize}
        onPageSizeChange={(s) => { setPageSize(s); setPage(1) }}
      />

      {submitFor && (
        <SubmitCountModal
          countName={submitFor.name}
          lines={varianceLines(submitFor.items)}
          onSubmit={submitCount}
          onClose={() => setSubmitFor(null)}
        />
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Tambah opname"
        footer={
          <>
            <Button variant="secondary" className="flex-1" onClick={() => setOpen(false)}>Batal</Button>
            <Button className="flex-1" loading={busy} onClick={createSC}>{busy ? 'Membuat...' : 'Tambah opname'}</Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input label="Nama *" type="text" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          {isAdmin && (
            <Select label="Lokasi *" value={form.locationKey} onChange={(e) => setForm((f) => ({ ...f, locationKey: e.target.value }))}>
              <option value="">Pilih lokasi...</option>
              <optgroup label="Outlet">
                {outlets.map((o) => <option key={o.id} value={`o:${o.id}`}>{o.name}</option>)}
              </optgroup>
              <optgroup label="Gudang">
                {warehouses.map((w) => <option key={w.id} value={`w:${w.id}`}>{w.name}</option>)}
              </optgroup>
            </Select>
          )}
          <Input label="Tanggal Rencana" type="date" value={form.plannedDate} onChange={(e) => setForm((f) => ({ ...f, plannedDate: e.target.value }))} />
          <Textarea label="Catatan" rows={2} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
          <div className="bg-amber-50 rounded-xl p-3 text-xs text-amber-700">
            Stok {freezeSummary(products)} akan dibekukan sebagai referensi.
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>
      </Modal>
    </div>
  )
}
