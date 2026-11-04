import { useState, useEffect, useMemo, useRef } from 'react'
import type {
  Customer,
  LoyaltySettings,
  LoyaltyCondition,
  Tag,
  Segment,
  Reminder,
  DupCandidate,
} from '@mandalika/api'
import { fetchAllPages } from '@mandalika/api'
import { Plus, Edit2, Trash2, Gift, Cake } from 'lucide-react'
import { api } from '../api'
import { activeProducts, productCatalogue } from '../lib/productCatalogue'
import { useCachedList } from '../hooks/useCachedList'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { TableSkeleton } from '../components/Skeleton'
import { buildExportName, exportToCSV, exportToXLSX } from '../lib/csvUtils'
import { CUSTOMER_TEMPLATE_ROWS } from '../lib/importTemplates'
import { ImportExportBar } from '../components/ImportExportBar'
import { Button } from '../ui/Button'
import { Switch } from '../ui/Switch'
import { Input, Select, Field } from '../ui/Field'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { Modal } from '../ui/Modal'
import { Card } from '../ui/Card'
import { Badge } from '../ui/Badge'
import { IconButton } from '../ui/IconButton'
import { EmptyState } from '../ui/EmptyState'
import { PageHeader } from '../ui/PageHeader'
import { Tabs } from '../ui/Tabs'
import { useScreenTabs } from '../lib/router/useScreenTabs'
import { useListState } from '../lib/router/useListState'
import { useRoute } from '../lib/router/useRoute'
import { backOrNavigate, navigate, previousRouteHash } from '../lib/router/navigate'
import { parseHash } from '../lib/router/hash'
import { FilterBar } from '../ui/FilterBar'
import { Pagination } from '../ui/Pagination'
import CustomerDetail from './customers/CustomerDetail'
import DupCandidates from './customers/DupCandidates'
import MergeReview from './customers/MergeReview'
import { SegmentManager } from './customers/SegmentManager'
import { CustomerEditorHost } from './customers/CustomerEditorHost'
import { CustomersTable } from './customers/CustomersTable'
import { customerExportRows, describeCustomerFilters } from './customers/customerExport'
import { ProductVariantPicker } from './customers/ProductVariantPicker'
import {
  CUSTOMER_LIST_SCHEMA,
  routedViewIsList,
  REMINDER_LIST_SCHEMA,
  REMINDER_PAGE_SIZE,
  customerHash,
  customerListHash,
  customerPlace,
  dupReviewHash,
  idOf,
  isListPath,
  loyaltyHash,
  pageOf,
  pageSizeOf,
  reminderTypeOf,
  reminderWindowOf,
  sortOf,
  type CustomerView,
  type LoyaltySub,
} from './customers/customerRoute'

const DEFAULT_LOYALTY: LoyaltySettings = {
  enabled: true,
  tierEnabled: true,
  pointsPerThousand: 1,
  redemptionRate: 100,
}
const DAYS_ID = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu']
const TRIGGER_OPTIONS = [
  { value: 'first_registration', label: 'Registrasi Pertama' },
  { value: 'birthday', label: 'Ulang Tahun Member' },
  { value: 'anniversary', label: 'Hari Jadi Member' },
  { value: 'double_date', label: 'Double Date (tgl = bln)' },
  { value: 'member_day', label: 'Member Day (hari tertentu)' },
  { value: 'product_purchase', label: 'Pembelian Produk Tertentu' },
  { value: 'spending_threshold', label: 'Capai Target Belanja' },
]
const REWARD_OPTIONS = [
  { value: 'set_points', label: 'Set Poin (langsung diberi)' },
  { value: 'multiply_points', label: 'Pengali Poin (multiplier)' },
  { value: 'product_reward', label: 'Reward Produk Gratis' },
]
type CondForm = Omit<LoyaltyCondition, 'id' | 'createdAt'>
const EMPTY_COND: CondForm = {
  name: '', type: 'always_on', trigger: 'first_registration',
  rewardType: 'set_points', rewardValue: 0, isActive: true,
  activeDays: [], applicableProductIds: [], rewardProductIds: [],
}

export default function Customers() {
  // Everything the list shows is in the URL: search, sort, tag, segment, page and page size (defaults stay out of it).
  const [urlList, setList] = useListState(CUSTOMER_LIST_SCHEMA)
  const route = useRoute()
  // While a customer is open the URL no longer carries the list's filters; keep the list keyed on the last list state,
  // so Back finds its data in place (no refetch, no skeleton that would clamp a restored scroll).
  const lastList = useRef(urlList)
  const onCustomerPage = customerPlace(route.path, 'daftar').customerId !== null || customerPlace(route.path, 'pengingat').customerId !== null
  if (!onCustomerPage) lastList.current = urlList
  const list = onCustomerPage ? lastList.current : urlList
  const search = list.q
  const sort = sortOf(list.urut)
  const tagId = idOf(list.tag)
  const segmentId = idOf(list.segmen)
  const page = pageOf(list.hal)
  const pageSize = pageSizeOf(list.per)
  const tagsQ = usePolledQuery<Tag[]>(() => api.listTags(), [])
  const allTags = tagsQ.data ?? []
  const segmentsQ = usePolledQuery<Segment[]>(() => api.listSegments(), [])
  const allSegments = segmentsQ.data ?? []
  const [segModalOpen, setSegModalOpen] = useState(false)

  const cq = usePolledQuery(
    () => api.listCustomers(page, pageSize, search, sort, tagId, segmentId),
    [page, pageSize, search, sort, tagId, segmentId],
  )
  const customers = cq.data?.data ?? []
  const total = cq.data?.meta?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const activeFilters = [search !== '', sort !== 'belanja', tagId !== '', segmentId !== ''].filter(Boolean).length
  const filterSummary = describeCustomerFilters(
    { q: search, sort, tagId, segmentId },
    (id) => allTags.find((t) => t.id === id)?.name,
    (id) => allSegments.find((sg) => sg.id === id)?.name,
  )
  // Every customer that matches the filters, not just the visible page.
  const exportCustomers = async (fmt: 'csv' | 'xlsx') => {
    const all = await fetchAllPages((p, l) => api.listCustomers(p, l, search, sort, tagId, segmentId))
    if (all.length === 0) return
    const rows = customerExportRows(all)
    const name = buildExportName('pelanggan', filterSummary)
    if (fmt === 'csv') exportToCSV(rows, name)
    else exportToXLSX(rows, name)
  }
  // A page past the end (a stale link, or rows deleted meanwhile) comes back empty: land on the last page instead.
  // Only on the list itself, and only on an answer to THIS page (a poll hook keeps the previous answer for a render).
  const onList = !onCustomerPage && routedViewIsList(route.path)
  useEffect(() => {
    if (!onList || cq.loading || !cq.data || cq.data.meta?.page !== page || page <= 1 || customers.length > 0) return
    setList({ hal: Math.min(page - 1, totalPages) }, { replace: true })
  }, [onList, cq.loading, cq.data, page, customers.length, totalPages, setList])

  const lq = usePolledQuery<LoyaltySettings>(() => api.getLoyaltySettings(), [])
  const condQ = usePolledQuery<LoyaltyCondition[]>(() => api.listLoyaltyConditions(), [])
  const [condOpen, setCondOpen] = useState(false)
  // The loyalty product pickers are behind the condition form: read the shared catalogue only while it is open.
  const pq = useCachedList(productCatalogue, { enabled: condOpen })
  const loyalty = lq.data ?? DEFAULT_LOYALTY
  const conditions = condQ.data ?? []
  const products = useMemo(() => activeProducts(pq.data) ?? [], [pq.data])

  // The view, the customer page, the duplicate under review and the loyalty sub-view all live in the path.
  const { tab: routedView, setTab: setView } = useScreenTabs<CustomerView>('customers', null)
  const view = routedView ?? 'daftar'
  const place = customerPlace(route.path, view)
  const selectedId = place.customerId
  const selectedDupId = place.dupId
  const subTab: LoyaltySub = place.loyaltySub
  const openCustomer = (id: string) => void navigate(customerHash(view === 'pengingat' ? 'pengingat' : 'daftar', id))
  // "Kembali" steps back to the list the person came from (filters, page and scroll are still there); a pasted link has none.
  const toList = () => void backOrNavigate(customerListHash(view), (path) => isListPath(path, view))
  // After the record is gone (deleted, merged, dismissed) the page replaces itself with the list, so Forward cannot reach it.
  const exitAfterRemoval = () => {
    const previous = previousRouteHash()
    const target = previous !== undefined && isListPath(parseHash(previous).path, view) ? previous : customerListHash(view)
    void navigate(target, { replace: true })
  }
  const [dupRefresh, setDupRefresh] = useState(0)
  const dupCountQ = usePolledQuery<{ data: DupCandidate[]; meta?: { total: number; page: number; limit: number } }>(
    () => api.listDupCandidates('pending', 1, 1),
    [dupRefresh],
  )
  const dupCount = dupCountQ.data?.meta?.total ?? 0
  // Leaving a review (merged, dismissed or just back) refreshes the pending count and the list.
  const hadDupReview = useRef(false)
  useEffect(() => {
    if (selectedDupId) hadDupReview.current = true
    else if (hadDupReview.current) {
      hadDupReview.current = false
      setDupRefresh((n) => n + 1)
    }
  }, [selectedDupId])
  const [remState, setRemState] = useListState(REMINDER_LIST_SCHEMA)
  const remWindow = reminderWindowOf(remState.hari)
  const remType = reminderTypeOf(remState.jenis)
  const remPage = pageOf(remState.hal)
  const remLimit = REMINDER_PAGE_SIZE
  const remQ = usePolledQuery(
    () => api.listReminders({ window: remWindow, type: remType, page: remPage, limit: remLimit }),
    [remWindow, remType, remPage],
  )
  const reminders = remQ.data?.data ?? []
  const remTotal = remQ.data?.meta?.total ?? 0
  const remTotalPages = Math.max(1, Math.ceil(remTotal / remLimit))

  // What failed to load for the view on show (the list's own error is inside its table).
  const loadErr =
    view === 'loyalitas'
      ? lq.error ?? condQ.error
      : view === 'pengingat'
        ? remQ.error
        : view === 'daftar'
          ? tagsQ.error ?? segmentsQ.error
          : null
  // The edit panel, the delete question and the errors of actions that have no dialog of their own.
  const [editor, setEditor] = useState<{ customer: Customer | null } | null>(null)
  const [delTarget, setDelTarget] = useState<Customer | null>(null)
  const [delBusy, setDelBusy] = useState(false)
  const [delErr, setDelErr] = useState<string | null>(null)
  const [pageErr, setPageErr] = useState<string | null>(null)

  const [loyaltyForm, setLoyaltyForm] = useState<LoyaltySettings>(DEFAULT_LOYALTY)
  // Seed the form from the server ONCE on first load. Guarding with a ref keeps a
  // background poll refetch (usePolledQuery) from clobbering the user's unsaved edits.
  const loyaltySeeded = useRef(false)
  useEffect(() => {
    if (lq.data && !loyaltySeeded.current) {
      setLoyaltyForm(lq.data)
      loyaltySeeded.current = true
    }
  }, [lq.data])
  const [savingLoyalty, setSavingLoyalty] = useState(false)

  const [editingCond, setEditingCond] = useState<LoyaltyCondition | null>(null)
  const [condForm, setCondForm] = useState<CondForm>(EMPTY_COND)
  const [condBusy, setCondBusy] = useState(false)
  const [condErr, setCondErr] = useState<string | null>(null)
  const [condDel, setCondDel] = useState<LoyaltyCondition | null>(null)
  const [condDelBusy, setCondDelBusy] = useState(false)
  const [condDelErr, setCondDelErr] = useState<string | null>(null)

  const askDelete = (c: Customer) => {
    setDelErr(null)
    setDelTarget(c)
  }
  // A refused delete keeps the question open with the server's reason; busy blocks a second click.
  const confirmDelete = async () => {
    if (!delTarget) return
    setDelBusy(true)
    try {
      await api.deleteCustomer(delTarget.id)
    } catch (e: unknown) {
      setDelErr(e instanceof Error ? e.message : 'Gagal menghapus pelanggan.')
      return
    } finally {
      setDelBusy(false)
    }
    const gone = delTarget.id
    setDelTarget(null)
    if (selectedId === gone) exitAfterRemoval()
    await cq.refetch()
  }

  const saveLoyalty = async () => {
    setSavingLoyalty(true)
    setPageErr(null)
    try {
      await api.updateLoyaltySettings(loyaltyForm)
      await lq.refetch()
    } catch (e: unknown) {
      setPageErr(`Pengaturan loyalitas gagal disimpan: ${e instanceof Error ? e.message : 'coba lagi.'}`)
    } finally {
      setSavingLoyalty(false)
    }
  }

  const openEditCond = (c: LoyaltyCondition) => {
    setEditingCond(c)
    setCondForm({
      name: c.name, type: c.type, trigger: c.trigger, rewardType: c.rewardType,
      rewardValue: c.rewardValue, rewardProductIds: c.rewardProductIds || [],
      isActive: c.isActive, campaignStartDate: c.campaignStartDate,
      campaignEndDate: c.campaignEndDate, activeDays: c.activeDays || [],
      applicableProductIds: c.applicableProductIds || [], minimumSpend: c.minimumSpend,
    })
    setCondErr(null)
    setCondOpen(true)
  }
  const saveCond = async () => {
    if (!condForm.name.trim()) {
      setCondErr('Nama kondisi wajib diisi')
      return
    }
    if (condForm.rewardType === 'product_reward' && !(condForm.rewardProductIds || []).length) {
      setCondErr('Pilih minimal satu produk hadiah untuk reward Produk Gratis')
      return
    }
    if (condForm.type === 'campaign' && (!condForm.campaignStartDate || !condForm.campaignEndDate)) {
      setCondErr('Campaign wajib punya tanggal mulai DAN berakhir (tanpa keduanya kondisi tidak akan pernah aktif)')
      return
    }
    setCondBusy(true)
    setCondErr(null)
    try {
      if (editingCond) await api.updateLoyaltyCondition(editingCond.id, condForm)
      else await api.createLoyaltyCondition(condForm)
      setCondOpen(false)
      await condQ.refetch()
    } catch (e: unknown) {
      setCondErr(e instanceof Error ? e.message : 'Gagal menyimpan kondisi.')
    } finally {
      setCondBusy(false)
    }
  }
  const toggleCond = async (c: LoyaltyCondition) => {
    setPageErr(null)
    try {
      await api.updateLoyaltyCondition(c.id, { ...c, isActive: !c.isActive })
      await condQ.refetch()
    } catch (e: unknown) {
      setPageErr(`Status kondisi "${c.name}" gagal diubah: ${e instanceof Error ? e.message : 'coba lagi.'}`)
    }
  }
  const confirmDeleteCond = async () => {
    if (!condDel) return
    setCondDelBusy(true)
    try {
      await api.deleteLoyaltyCondition(condDel.id)
    } catch (e: unknown) {
      setCondDelErr(e instanceof Error ? e.message : 'Gagal menghapus kondisi.')
      return
    } finally {
      setCondDelBusy(false)
    }
    setCondDel(null)
    await condQ.refetch()
  }

  return (
    <>
      {selectedId ? (
        <CustomerDetail
          customerId={selectedId}
          loyaltyEnabled={loyalty.enabled}
          onBack={() => { toList(); void cq.refetch() }}
          onEdit={(c) => setEditor({ customer: c })}
          onDelete={askDelete}
        />
      ) : (
        <div className="p-6 space-y-5">
          <PageHeader
        title="Pelanggan"
        subtitle={`${total} pelanggan terdaftar`}
        actions={
          <>
            <Tabs
              value={view}
              onChange={setView}
              tabs={[
                { id: 'daftar', label: 'Daftar' },
                { id: 'pengingat', label: 'Pengingat' },
                { id: 'duplikat', label: dupCount ? `Duplikat (${dupCount})` : 'Duplikat' },
                { id: 'loyalitas', label: 'Loyalitas' },
              ]}
            />
            {view === 'daftar' && (
              <>
                <ImportExportBar
                  onExport={exportCustomers}
                  exportDisabled={customers.length === 0}
                  filterSummary={filterSummary}
                  importKind="customers"
                  onImported={() => void cq.refetch()}
                  onTemplate={() => exportToCSV(CUSTOMER_TEMPLATE_ROWS, 'template_pelanggan_mandalika')}
                />
                <Button icon={<Plus className="w-4 h-4" />} onClick={() => setEditor({ customer: null })}>
                  Tambah
                </Button>
              </>
            )}
            {view === 'loyalitas' && subTab === 'conditions' && (
              <Button icon={<Plus className="w-4 h-4" />} onClick={() => { setEditingCond(null); setCondForm({ ...EMPTY_COND }); setCondOpen(true) }}>
                Tambah Kondisi
              </Button>
            )}
          </>
        }
      />

      {(pageErr || loadErr) && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-xl bg-danger-bg px-4 py-3 text-sm text-danger">
          <span>{pageErr ?? loadErr}</span>
          {pageErr && <Button variant="ghost" size="sm" onClick={() => setPageErr(null)}>Tutup</Button>}
        </div>
      )}

      {view === 'loyalitas' ? (
        <div className="space-y-4">
          <Tabs
            value={subTab}
            onChange={(sub) => void navigate(loyaltyHash(sub), { replace: sub === subTab })}
            tabs={[
              { id: 'general', label: 'Pengaturan Umum' },
              { id: 'conditions', label: 'Kondisi Khusus' },
            ]}
            className="self-start"
          />

          {subTab === 'general' && (
            <Card className="p-6 space-y-5 max-w-lg">
              <h3 className="font-black text-gray-900">Pengaturan Loyalitas</h3>
              <div className="flex items-center justify-between py-3 border-b border-gray-100">
                <div>
                  <p className="font-bold text-gray-900 text-sm">Sistem Poin</p>
                  <p className="text-xs text-gray-400">Pelanggan mendapat poin setiap transaksi</p>
                </div>
                <Switch label="Sistem Poin" checked={loyaltyForm.enabled} onChange={(enabled) => setLoyaltyForm((f) => ({ ...f, enabled }))} />
              </div>
              {loyaltyForm.enabled && (
                <>
                  <Input
                    label="Poin per Rp 1.000 belanja"
                    type="number"
                    value={loyaltyForm.pointsPerThousand}
                    onChange={(e) => setLoyaltyForm((f) => ({ ...f, pointsPerThousand: parseFloat(e.target.value) || 1 }))}
                  />
                  <Input
                    label="Poin untuk Rp 1.000 diskon"
                    type="number"
                    value={loyaltyForm.redemptionRate}
                    onChange={(e) => setLoyaltyForm((f) => ({ ...f, redemptionRate: parseFloat(e.target.value) || 100 }))}
                  />
                </>
              )}
              <p className="text-xs text-gray-400">Nilai aktif: {loyalty.enabled ? 'poin ON' : 'poin OFF'}</p>
              <Button className="w-full" loading={savingLoyalty} disabled={!lq.data} onClick={saveLoyalty}>
                {savingLoyalty ? 'Menyimpan...' : 'Simpan Pengaturan'}
              </Button>
            </Card>
          )}

          {subTab === 'conditions' && (
            <div className="space-y-3">
              {conditions.length === 0 ? (
                <Card>
                  <EmptyState icon={<Gift />} title="Belum ada kondisi loyalitas" />
                </Card>
              ) : (
                <Card className="divide-y divide-gray-50">
                  {conditions.map((c) => (
                    <div key={c.id} className="px-5 py-4 flex items-center justify-between hover:bg-gray-50">
                      <div className="flex items-start gap-3">
                        <Badge tone={c.type === 'always_on' ? 'gold' : 'neutral'} className="mt-0.5 rounded-full">
                          {c.type === 'always_on' ? 'Always-On' : 'Campaign'}
                        </Badge>
                        <div>
                          <p className="font-bold text-gray-900 text-sm">{c.name}</p>
                          <p className="text-xs text-gray-400">
                            {TRIGGER_OPTIONS.find((t) => t.value === c.trigger)?.label} →{' '}
                            {c.rewardType === 'set_points' ? `+${c.rewardValue} Poin` : c.rewardType === 'multiply_points' ? `×${c.rewardValue} Poin` : 'Produk Gratis'}
                          </p>
                          {typeof c.appliedCount === 'number' && c.appliedCount > 0 && (
                            <p className="text-xs text-gray-400">Terpakai: {c.appliedCount}×</p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <button type="button" onClick={() => toggleCond(c)}>
                          <Badge tone={c.isActive ? 'success' : 'neutral'}>{c.isActive ? 'Aktif' : 'Nonaktif'}</Badge>
                        </button>
                        <IconButton aria-label={`Ubah kondisi ${c.name}`} onClick={() => openEditCond(c)}><Edit2 className="w-4 h-4" /></IconButton>
                        <IconButton tone="danger" aria-label={`Hapus kondisi ${c.name}`} onClick={() => { setCondDelErr(null); setCondDel(c) }}><Trash2 className="w-4 h-4" /></IconButton>
                      </div>
                    </div>
                  ))}
                </Card>
              )}
            </div>
          )}
        </div>
      ) : view === 'duplikat' ? (
        selectedDupId ? (
          <MergeReview candidateId={selectedDupId} onBack={toList} onDone={exitAfterRemoval} />
        ) : (
          <DupCandidates refreshKey={dupRefresh} onReview={(id) => void navigate(dupReviewHash(id))} />
        )
      ) : view === 'pengingat' ? (
        <Card className="overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex flex-wrap items-center gap-2">
            <div className="flex gap-1">
              {([7, 30] as const).map((wdw) => (
                <button key={wdw} type="button" onClick={() => setRemState({ hari: wdw, hal: 1 })}
                  className={`px-3 py-1.5 text-sm font-bold rounded-lg border ${remWindow === wdw ? 'bg-gold-50 border-gold-200 text-gold-700' : 'bg-white border-gray-200 text-gray-500'}`}>
                  {wdw} hari
                </button>
              ))}
            </div>
            <div className="flex gap-1">
              {(['all', 'birthday', 'anniversary'] as const).map((tp) => (
                <button key={tp} type="button" onClick={() => setRemState({ jenis: tp, hal: 1 })}
                  className={`px-3 py-1.5 text-sm font-bold rounded-lg border ${remType === tp ? 'bg-gold-50 border-gold-200 text-gold-700' : 'bg-white border-gray-200 text-gray-500'}`}>
                  {tp === 'all' ? 'Semua' : tp === 'birthday' ? 'Ulang Tahun' : 'Hari Jadi'}
                </button>
              ))}
            </div>
          </div>
          {remQ.loading && reminders.length === 0 ? (
            <TableSkeleton />
          ) : reminders.length === 0 ? (
            <EmptyState icon={<Cake />} title="Tidak ada pengingat dalam rentang ini" />
          ) : (
            <div className="divide-y divide-gray-50">
              {reminders.map((rm: Reminder, i: number) => (
                <div key={`${rm.id}-${rm.kind}-${i}`} className="px-5 py-3 flex items-center gap-3 hover:bg-gray-50 cursor-pointer"
                  role="button" tabIndex={0}
                  onClick={() => openCustomer(rm.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCustomer(rm.id) } }}>
                  <span className="text-lg flex-shrink-0">{rm.kind === 'birthday' ? '🎂' : '💍'}</span>
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-gray-900 text-sm">{rm.name}</p>
                    <p className="text-xs text-gray-400">{rm.phone} · {rm.kind === 'birthday' ? 'Ulang Tahun' : 'Hari Jadi'}</p>
                  </div>
                  <span className="text-xs font-bold text-gold-700 flex-shrink-0">
                    {rm.daysUntil === 0 ? 'Hari ini' : `Dalam ${rm.daysUntil} hari`}
                  </span>
                </div>
              ))}
            </div>
          )}
          {remTotal > remLimit && (
            <div className="px-4 py-2 border-t border-gray-100">
              <Pagination page={remPage} totalPages={remTotalPages} total={remTotal}
                onChange={(hal) => setRemState({ hal })} pageSize={remLimit}
                onPageSizeChange={() => { /* fixed 25 */ }} pageSizes={[remLimit]} />
            </div>
          )}
        </Card>
      ) : (
        <>
          <FilterBar
            onReset={() => setList({ q: '', urut: 'belanja', tag: '', segmen: '', hal: 1 })}
            activeCount={activeFilters}
            actions={<Button variant="secondary" size="sm" onClick={() => setSegModalOpen(true)}>Kelola Segmen</Button>}
          >
            <FilterBar.Search
              label="Cari pelanggan"
              placeholder="Cari nama / telepon / email..."
              value={search}
              onChange={(q) => setList({ q, hal: 1 }, { replace: true })}
            />
            <FilterBar.Chips
              label="Urutkan"
              items={[{ id: 'belanja', label: 'Belanja Tertinggi' }, { id: 'terbaru', label: 'Terbaru' }]}
              value={sort}
              onChange={(urut) => setList({ urut, hal: 1 })}
            />
            <FilterBar.Select
              label="Tag"
              value={tagId}
              onChange={(tag) => setList({ tag, hal: 1 })}
              options={[{ value: '', label: 'Semua tag' }, ...allTags.map((t) => ({ value: t.id, label: t.name }))]}
            />
            <FilterBar.Select
              label="Segmen"
              value={segmentId}
              onChange={(segmen) => setList({ segmen, hal: 1 })}
              options={[{ value: '', label: 'Semua segmen' }, ...allSegments.map((sg) => ({ value: sg.id, label: sg.name }))]}
            />
          </FilterBar>
          <CustomersTable
            rows={customers}
            loading={cq.loading}
            error={cq.error ? `Daftar pelanggan gagal dimuat: ${cq.error}` : null}
            onRetry={() => void cq.refetch()}
            showPoints={loyalty.enabled}
            filtered={activeFilters > 0}
            selectedId={editor?.customer?.id ?? null}
            onOpen={(c) => openCustomer(c.id)}
            onEdit={(c) => setEditor({ customer: c })}
            onDelete={askDelete}
            footer={
              total > 0 ? (
                <Pagination
                  page={page}
                  totalPages={totalPages}
                  total={total}
                  onChange={(hal) => setList({ hal })}
                  pageSize={pageSize}
                  onPageSizeChange={(per) => setList({ per, hal: 1 })}
                />
              ) : undefined
            }
          />
          </>
        )}
        </div>
      )}

      <Modal open={segModalOpen} onClose={() => setSegModalOpen(false)} title="Kelola Segmen">
        <SegmentManager segments={allSegments} onChange={() => void segmentsQ.refetch()} />
      </Modal>

      {editor && (
        <CustomerEditorHost
          key={editor.customer?.id ?? 'new'}
          customer={editor.customer}
          onSaved={() => cq.refetch()}
          onClose={() => setEditor(null)}
        />
      )}

      <Modal
        open={condOpen}
        onClose={() => setCondOpen(false)}
        size="lg"
        title={editingCond ? 'Edit Kondisi' : 'Tambah Kondisi Loyalitas'}
        footer={
          <>
            <Button variant="secondary" className="flex-1" onClick={() => setCondOpen(false)}>Batal</Button>
            <Button className="flex-1" loading={condBusy} onClick={saveCond}>{condBusy ? 'Menyimpan...' : 'Simpan'}</Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input label="Nama Kondisi *" type="text" value={condForm.name} onChange={(e) => setCondForm((f) => ({ ...f, name: e.target.value }))} />
          <Field label="Tipe">
            <div className="grid grid-cols-2 gap-2">
              {(['always_on', 'campaign'] as const).map((tv) => (
                <button key={tv} type="button" onClick={() => setCondForm((f) => ({ ...f, type: tv }))} className={`p-3 rounded-xl border-2 text-left ${condForm.type === tv ? 'border-gold-500 bg-gold-50' : 'border-gray-200'}`}>
                  <p className="font-black text-sm text-gray-700">{tv === 'always_on' ? 'Always-On' : 'Campaign-Based'}</p>
                </button>
              ))}
            </div>
          </Field>
          <Select label="Trigger" value={condForm.trigger} onChange={(e) => setCondForm((f) => ({ ...f, trigger: e.target.value }))}>
            {TRIGGER_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </Select>
          {condForm.trigger === 'member_day' && (
            <Field label="Pilih Hari">
              <div className="flex gap-1.5 flex-wrap">
                {DAYS_ID.map((d, i) => (
                  <button key={d} type="button" onClick={() => setCondForm((f) => ({ ...f, activeDays: (f.activeDays || []).includes(i) ? (f.activeDays || []).filter((x) => x !== i) : [...(f.activeDays || []), i] }))} className={`px-3 py-1.5 rounded-lg text-xs font-bold border-2 ${(condForm.activeDays || []).includes(i) ? 'bg-gold-600 text-white border-gold-600' : 'border-gray-200 text-gray-600'}`}>{d}</button>
                ))}
              </div>
            </Field>
          )}
          {condForm.trigger === 'product_purchase' && (
            <Field label="Produk Pemicu (produk utuh atau varian tertentu)">
              <ProductVariantPicker
                products={products}
                value={condForm.applicableProductIds || []}
                onChange={(next) => setCondForm((f) => ({ ...f, applicableProductIds: next }))}
              />
            </Field>
          )}
          {condForm.trigger === 'spending_threshold' && (
            <Input label="Target Belanja (Rp)" type="number" value={condForm.minimumSpend || ''} onChange={(e) => setCondForm((f) => ({ ...f, minimumSpend: parseFloat(e.target.value) || 0 }))} />
          )}
          <Select label="Reward" value={condForm.rewardType} onChange={(e) => setCondForm((f) => ({ ...f, rewardType: e.target.value as CondForm['rewardType'] }))}>
            {REWARD_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </Select>
          {condForm.rewardType !== 'product_reward' && (
            <Input label={condForm.rewardType === 'set_points' ? 'Jumlah Poin' : 'Pengali (×)'} type="number" value={condForm.rewardValue} onChange={(e) => setCondForm((f) => ({ ...f, rewardValue: parseFloat(e.target.value) || 0 }))} />
          )}
          {condForm.rewardType === 'product_reward' && (
            <Field label="Produk Hadiah (pilihan item gratis untuk kasir)">
              <ProductVariantPicker
                products={products}
                value={condForm.rewardProductIds || []}
                onChange={(next) => setCondForm((f) => ({ ...f, rewardProductIds: next }))}
              />
            </Field>
          )}
          {condForm.type === 'campaign' && (
            <div className="grid grid-cols-2 gap-4">
              <Input label="Campaign Mulai" type="date" value={condForm.campaignStartDate || ''} onChange={(e) => setCondForm((f) => ({ ...f, campaignStartDate: e.target.value }))} />
              <Input label="Campaign Berakhir" type="date" value={condForm.campaignEndDate || ''} onChange={(e) => setCondForm((f) => ({ ...f, campaignEndDate: e.target.value }))} />
            </div>
          )}
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={condForm.isActive} onChange={(e) => setCondForm((f) => ({ ...f, isActive: e.target.checked }))} className="w-4 h-4 accent-gold-600" />
            <span className="text-sm font-bold text-gray-700">Kondisi Aktif</span>
          </label>
          {condErr && <p role="alert" className="text-sm text-red-600">{condErr}</p>}
        </div>
      </Modal>

      <ConfirmDialog
        open={delTarget !== null}
        title={delTarget ? `Hapus ${delTarget.name}?` : 'Hapus pelanggan?'}
        consequence="Data poin dan riwayat akan terhapus permanen."
        confirmLabel="Hapus pelanggan"
        tone="danger"
        busy={delBusy}
        error={delErr}
        onConfirm={() => void confirmDelete()}
        onCancel={() => { if (!delBusy) setDelTarget(null) }}
      />

      <ConfirmDialog
        open={condDel !== null}
        title={condDel ? `Hapus kondisi "${condDel.name}"?` : 'Hapus kondisi?'}
        consequence="Kondisi ini berhenti memberi hadiah mulai sekarang. Hadiah yang sudah diberikan tetap tercatat."
        confirmLabel="Hapus kondisi"
        tone="danger"
        busy={condDelBusy}
        error={condDelErr}
        onConfirm={() => void confirmDeleteCond()}
        onCancel={() => { if (!condDelBusy) setCondDel(null) }}
      />
    </>
  )
}
