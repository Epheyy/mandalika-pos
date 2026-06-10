import { useState, useEffect } from 'react'
import type {
  Customer,
  LoyaltySettings,
  LoyaltyCondition,
  Product,
  Tag,
  Segment,
  Reminder,
} from '@mandalika/api'
import {
  Plus, Search, Edit2, Trash2, Users, Phone, Mail, Star,
  ToggleLeft, ToggleRight, Gift, Cake,
} from 'lucide-react'
import { api } from '../api'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { TableSkeleton } from '../components/Skeleton'
import { BRAND } from '../lib/brand'
import { exportToCSV, exportToXLSX } from '../lib/csvUtils'
import { ImportExportBar } from '../components/ImportExportBar'
import {
  Button, Input, Select, Field, Modal, Card, Badge, IconButton, EmptyState, PageHeader, Tabs, Pagination,
} from '../ui'
import CustomerDetail from './customers/CustomerDetail'
import { SegmentManager } from './customers/SegmentManager'
import { tagChipClasses } from './customers/tagColors'

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
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [sort, setSort] = useState<'belanja' | 'terbaru'>('belanja')
  const [tagId, setTagId] = useState('')
  const [segmentId, setSegmentId] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const tagsQ = usePolledQuery<Tag[]>(() => api.listTags(), [])
  const allTags = tagsQ.data ?? []
  const segmentsQ = usePolledQuery<Segment[]>(() => api.listSegments(), [])
  const allSegments = segmentsQ.data ?? []
  const [segModalOpen, setSegModalOpen] = useState(false)

  const [debouncedSearch, setDebouncedSearch] = useState('')
  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(search); setPage(1) }, 300)
    return () => clearTimeout(t)
  }, [search])

  const cq = usePolledQuery(
    () => api.listCustomers(page, pageSize, debouncedSearch, sort, tagId, segmentId),
    [page, pageSize, debouncedSearch, sort, tagId, segmentId],
  )
  const customers = cq.data?.data ?? []
  const total = cq.data?.meta?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const lq = usePolledQuery<LoyaltySettings>(() => api.getLoyaltySettings(), [])
  const condQ = usePolledQuery<LoyaltyCondition[]>(() => api.listLoyaltyConditions(), [])
  const pq = usePolledQuery<Product[]>(
    () => api.listProducts().then((r) => r.data.filter((p) => p.isActive)),
    [],
  )
  const loyalty = lq.data ?? DEFAULT_LOYALTY
  const conditions = condQ.data ?? []
  const products = pq.data ?? []

  const [tab, setTab] = useState<'customers' | 'settings'>('customers')
  const [subTab, setSubTab] = useState<'general' | 'conditions'>('general')

  // Customers sub-view + reminders (SP-CRM-6)
  const [custView, setCustView] = useState<'daftar' | 'pengingat'>('daftar')
  const [remWindow, setRemWindow] = useState<7 | 30>(7)
  const [remType, setRemType] = useState<'all' | 'birthday' | 'anniversary'>('all')
  const [remPage, setRemPage] = useState(1)
  const remLimit = 25
  const remQ = usePolledQuery(
    () => api.listReminders({ window: remWindow, type: remType, page: remPage, limit: remLimit }),
    [remWindow, remType, remPage],
  )
  const reminders = remQ.data?.data ?? []
  const remTotal = remQ.data?.meta?.total ?? 0
  const remTotalPages = Math.max(1, Math.ceil(remTotal / remLimit))

  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Customer | null>(null)
  const [form, setForm] = useState({ name: '', phone: '', email: '', birthday: '', anniversary: '', notes: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [delId, setDelId] = useState<string | null>(null)

  const [phoneDupe, setPhoneDupe] = useState(false)
  useEffect(() => {
    if (!open) { setPhoneDupe(false); return }
    const phone = form.phone.trim()
    if (!phone) { setPhoneDupe(false); return }
    let ignore = false
    const t = setTimeout(async () => {
      try {
        const matches = await api.getCustomersByPhone(phone)
        if (!ignore) setPhoneDupe(matches.some((m) => m.id !== (editing?.id ?? null)))
      } catch {
        if (!ignore) setPhoneDupe(false)
      }
    }, 300)
    return () => { clearTimeout(t); ignore = true }
  }, [open, form.phone, editing?.id])

  const exportCustomers = async (fmt: 'csv' | 'xlsx') => {
    const result = await api.listCustomers(1, 10000)
    const rows = result.data.map((c) => ({
      Nama: c.name,
      Telepon: c.phone,
      Email: c.email ?? '',
      Poin: c.points,
      'Total Belanja': c.totalSpent,
      'Jumlah Kunjungan': c.visitCount,
      Tag: (c.tags ?? []).map((t) => t.name).join(', '),
      Segmen: c.segment?.name ?? '',
    }))
    if (fmt === 'csv') exportToCSV(rows, 'pelanggan')
    else exportToXLSX(rows, 'pelanggan')
  }

  const [loyaltyForm, setLoyaltyForm] = useState<LoyaltySettings>(DEFAULT_LOYALTY)
  useEffect(() => {
    if (lq.data) setLoyaltyForm(lq.data)
  }, [lq.data])
  const [savingLoyalty, setSavingLoyalty] = useState(false)

  const [condOpen, setCondOpen] = useState(false)
  const [editingCond, setEditingCond] = useState<LoyaltyCondition | null>(null)
  const [condForm, setCondForm] = useState<CondForm>(EMPTY_COND)

  const saveCustomer = async () => {
    if (!form.name.trim() || !form.phone.trim()) {
      setErr('Nama & telepon wajib diisi')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const body = {
        name: form.name.trim(),
        phone: form.phone.trim(),
        email: form.email.trim(),
        birthday: form.birthday,
        anniversary: form.anniversary,
        notes: form.notes.trim(),
      }
      if (editing) await api.updateCustomer(editing.id, body)
      else await api.createCustomer(body)
      setOpen(false)
      await cq.refetch()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal menyimpan pelanggan.')
    } finally {
      setBusy(false)
    }
  }

  const del = async (cid: string) => {
    try {
      await api.deleteCustomer(cid)
      setDelId(null)
      setSelectedId(null)
      await cq.refetch()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal menghapus pelanggan.')
      setDelId(null)
    }
  }

  const saveLoyalty = async () => {
    setSavingLoyalty(true)
    try {
      await api.updateLoyaltySettings(loyaltyForm)
      await lq.refetch()
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
    setCondOpen(true)
  }
  const saveCond = async () => {
    if (!condForm.name.trim()) {
      setErr('Nama kondisi wajib diisi')
      return
    }
    setBusy(true)
    try {
      if (editingCond) await api.updateLoyaltyCondition(editingCond.id, condForm)
      else await api.createLoyaltyCondition(condForm)
      setCondOpen(false)
      await condQ.refetch()
    } finally {
      setBusy(false)
    }
  }
  const toggleCond = async (c: LoyaltyCondition) => {
    await api.updateLoyaltyCondition(c.id, { ...c, isActive: !c.isActive })
    await condQ.refetch()
  }

  return (
    <>
      {selectedId ? (
        <CustomerDetail
          customerId={selectedId}
          loyaltyEnabled={loyalty.enabled}
          onBack={() => { setSelectedId(null); void cq.refetch() }}
          onEdit={(c) => { setEditing(c); setForm({ name: c.name, phone: c.phone, email: c.email || '', birthday: c.birthday || '', anniversary: c.anniversary || '', notes: c.notes || '' }); setErr(null); setOpen(true) }}
          onDelete={(cid) => setDelId(cid)}
        />
      ) : (
        <div className="p-6 space-y-5">
          <PageHeader
        title="Pelanggan"
        subtitle={`${total} pelanggan terdaftar`}
        actions={
          <>
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { id: 'customers', label: 'Pelanggan' },
                { id: 'settings', label: 'Loyalitas' },
              ]}
            />
            {tab === 'customers' && (
              <>
                <Tabs
                  value={custView}
                  onChange={setCustView}
                  tabs={[
                    { id: 'daftar', label: 'Daftar' },
                    { id: 'pengingat', label: 'Pengingat' },
                  ]}
                />
                {custView === 'daftar' && (
                  <>
                    <ImportExportBar
                      onExport={(fmt) => void exportCustomers(fmt)}
                      exportDisabled={customers.length === 0}
                    />
                    <Button icon={<Plus className="w-4 h-4" />} onClick={() => { setEditing(null); setForm({ name: '', phone: '', email: '', birthday: '', anniversary: '', notes: '' }); setErr(null); setOpen(true) }}>
                      Tambah
                    </Button>
                  </>
                )}
              </>
            )}
            {tab === 'settings' && subTab === 'conditions' && (
              <Button icon={<Plus className="w-4 h-4" />} onClick={() => { setEditingCond(null); setCondForm({ ...EMPTY_COND }); setCondOpen(true) }}>
                Tambah Kondisi
              </Button>
            )}
          </>
        }
      />

      {tab === 'settings' ? (
        <div className="space-y-4">
          <Tabs
            value={subTab}
            onChange={setSubTab}
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
                <button onClick={() => setLoyaltyForm((f) => ({ ...f, enabled: !f.enabled }))}>
                  {loyaltyForm.enabled ? <ToggleRight className="w-7 h-7 text-gold-600" /> : <ToggleLeft className="w-7 h-7 text-gray-400" />}
                </button>
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
              <Button className="w-full" loading={savingLoyalty} onClick={saveLoyalty}>
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
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <button onClick={() => toggleCond(c)}>
                          <Badge tone={c.isActive ? 'success' : 'neutral'}>{c.isActive ? 'Aktif' : 'Nonaktif'}</Badge>
                        </button>
                        <IconButton onClick={() => openEditCond(c)}><Edit2 className="w-4 h-4" /></IconButton>
                        <IconButton tone="danger" onClick={async () => { await api.deleteLoyaltyCondition(c.id); await condQ.refetch() }}><Trash2 className="w-4 h-4" /></IconButton>
                      </div>
                    </div>
                  ))}
                </Card>
              )}
            </div>
          )}
        </div>
      ) : custView === 'pengingat' ? (
        <Card className="overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex flex-wrap items-center gap-2">
            <div className="flex gap-1">
              {([7, 30] as const).map((wdw) => (
                <button key={wdw} type="button" onClick={() => { setRemWindow(wdw); setRemPage(1) }}
                  className={`px-3 py-1.5 text-sm font-bold rounded-lg border ${remWindow === wdw ? 'bg-gold-50 border-gold-200 text-gold-700' : 'bg-white border-gray-200 text-gray-500'}`}>
                  {wdw} hari
                </button>
              ))}
            </div>
            <div className="flex gap-1">
              {(['all', 'birthday', 'anniversary'] as const).map((tp) => (
                <button key={tp} type="button" onClick={() => { setRemType(tp); setRemPage(1) }}
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
                  onClick={() => setSelectedId(rm.id)}>
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
                onChange={setRemPage} pageSize={remLimit}
                onPageSizeChange={() => { /* fixed 25 */ }} pageSizes={[remLimit]} />
            </div>
          )}
        </Card>
      ) : (
        <>
          <div className="flex items-center flex-wrap gap-2">
            <div className="relative max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 z-10" />
              <Input type="text" placeholder="Cari nama / telepon / email..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
            </div>
            <div className="flex items-center gap-1">
              {([['belanja', 'Belanja Tertinggi'], ['terbaru', 'Terbaru']] as const).map(([val, label]) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => { setSort(val); setPage(1) }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold border-2 transition ${
                    sort === val ? 'bg-gold-600 text-white border-gold-600' : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <select
              value={tagId}
              onChange={(e) => { setTagId(e.target.value); setPage(1) }}
              className="text-xs font-bold rounded-lg border border-gray-200 px-2 py-1.5 bg-white text-gray-700"
            >
              <option value="">Semua tag</option>
              {allTags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <select
              value={segmentId}
              onChange={(e) => { setSegmentId(e.target.value); setPage(1) }}
              className="text-xs font-bold rounded-lg border border-gray-200 px-2 py-1.5 bg-white text-gray-700"
            >
              <option value="">Semua segmen</option>
              {allSegments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <Button variant="secondary" size="sm" onClick={() => setSegModalOpen(true)}>Kelola Segmen</Button>
          </div>
          <Card className="overflow-hidden">
            {cq.loading ? (
              <TableSkeleton />
            ) : customers.length === 0 ? (
              <EmptyState icon={<Users />} title="Tidak ada pelanggan" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50">
                      <th className="text-left px-5 py-3 text-xs font-black text-gray-400 uppercase tracking-wider">Pelanggan</th>
                      <th className="text-left px-5 py-3 text-xs font-black text-gray-400 uppercase tracking-wider hidden md:table-cell">Kontak</th>
                      <th className="text-left px-5 py-3 text-xs font-black text-gray-400 uppercase tracking-wider">Total Belanja</th>
                      {loyalty.enabled && <th className="text-left px-5 py-3 text-xs font-black text-gray-400 uppercase tracking-wider hidden sm:table-cell">Poin</th>}
                      <th className="text-left px-5 py-3 text-xs font-black text-gray-400 uppercase tracking-wider hidden sm:table-cell">Segmen</th>
                      <th className="text-right px-5 py-3 text-xs font-black text-gray-400 uppercase tracking-wider">Aksi</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {customers.map((c) => {
                      return (
                        <tr
                          key={c.id}
                          className="hover:bg-gray-50 cursor-pointer"
                          onClick={() => setSelectedId(c.id)}
                        >
                          <td className="px-5 py-3">
                            <div className="flex items-center gap-3">
                              <div className="w-9 h-9 rounded-full bg-gold-50 flex items-center justify-center flex-shrink-0">
                                <span className="text-sm font-black text-gold-600">{c.name.charAt(0).toUpperCase()}</span>
                              </div>
                              <div>
                                <p className="font-bold text-gray-900 text-sm">{c.name}</p>
                                <p className="text-xs text-gray-400">{c.visitCount} kunjungan</p>
                                {(c.tags ?? []).length > 0 && (
                                  <div className="flex flex-wrap gap-1 mt-1">
                                    {(c.tags ?? []).slice(0, 3).map((t) => (
                                      <span key={t.id} className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold border ${tagChipClasses(t.color)}`}>{t.name}</span>
                                    ))}
                                    {(c.tags ?? []).length > 3 && <span className="text-[10px] text-gray-400">+{(c.tags ?? []).length - 3}</span>}
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="px-5 py-3 hidden md:table-cell">
                            <div className="space-y-0.5">
                              <div className="flex items-center gap-1.5 text-xs text-gray-500"><Phone className="w-3 h-3" /> {c.phone}</div>
                              {c.email && <div className="flex items-center gap-1.5 text-xs text-gray-400"><Mail className="w-3 h-3" /> {c.email}</div>}
                            </div>
                          </td>
                          <td className="px-5 py-3"><p className="font-black text-gray-900 text-sm">{BRAND.currency.format(c.totalSpent)}</p></td>
                          {loyalty.enabled && (
                            <td className="px-5 py-3 hidden sm:table-cell">
                              <div className="flex items-center gap-1 text-sm font-bold text-gold-600"><Star className="w-3.5 h-3.5" />{c.points.toLocaleString('id-ID')}</div>
                            </td>
                          )}
                          <td className="px-5 py-3 hidden sm:table-cell">
                            {c.segment
                              ? <span className={`px-2.5 py-1 text-xs font-bold rounded-full border ${tagChipClasses(c.segment.color)}`}>{c.segment.name}</span>
                              : <span className="text-xs text-gray-300">—</span>}
                          </td>
                          <td className="px-5 py-3">
                            <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                              <IconButton onClick={() => { setEditing(c); setForm({ name: c.name, phone: c.phone, email: c.email || '', birthday: c.birthday || '', anniversary: c.anniversary || '', notes: c.notes || '' }); setErr(null); setOpen(true) }}><Edit2 className="w-4 h-4" /></IconButton>
                              <IconButton tone="danger" onClick={() => setDelId(c.id)}><Trash2 className="w-4 h-4" /></IconButton>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          {!cq.loading && total > 0 && (
            <Pagination
              page={page}
              totalPages={totalPages}
              total={total}
              onChange={setPage}
              pageSize={pageSize}
              onPageSizeChange={(s) => { setPageSize(s); setPage(1) }}
            />
          )}
          </>
        )}
        </div>
      )}

      <Modal open={segModalOpen} onClose={() => setSegModalOpen(false)} title="Kelola Segmen">
        <SegmentManager segments={allSegments} onChange={() => void segmentsQ.refetch()} />
      </Modal>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? 'Edit Pelanggan' : 'Tambah Pelanggan'}
        footer={
          <>
            <Button variant="secondary" className="flex-1" onClick={() => setOpen(false)}>Batal</Button>
            <Button className="flex-1" loading={busy} onClick={saveCustomer}>{busy ? 'Menyimpan...' : 'Simpan'}</Button>
          </>
        }
      >
        <div className="space-y-4">
          {[
            { label: 'Nama *', field: 'name' as const, type: 'text' },
            { label: 'No. Telepon *', field: 'phone' as const, type: 'tel' },
            { label: 'Email', field: 'email' as const, type: 'email' },
          ].map(({ label, field, type }) => (
            <Input key={field} label={label} type={type} value={form[field]} onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))} />
          ))}
          {phoneDupe && (
            <p className="text-xs text-amber-600">⚠ Nomor telepon ini sudah dipakai pelanggan lain. Tetap bisa disimpan.</p>
          )}
          <div className="grid grid-cols-2 gap-4">
            <Input label="Ulang Tahun" type="date" value={form.birthday} onChange={(e) => setForm((f) => ({ ...f, birthday: e.target.value }))} />
            <Input label="Hari Jadi" type="date" value={form.anniversary} onChange={(e) => setForm((f) => ({ ...f, anniversary: e.target.value }))} />
          </div>
          <Field label="Catatan">
            <textarea
              className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold-500/40 focus:border-gold-400"
              rows={3}
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            />
          </Field>
          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>
      </Modal>

      <Modal
        open={condOpen}
        onClose={() => setCondOpen(false)}
        size="lg"
        title={editingCond ? 'Edit Kondisi' : 'Tambah Kondisi Loyalitas'}
        footer={
          <>
            <Button variant="secondary" className="flex-1" onClick={() => setCondOpen(false)}>Batal</Button>
            <Button className="flex-1" loading={busy} onClick={saveCond}>{busy ? 'Menyimpan...' : 'Simpan'}</Button>
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
                  <button key={i} type="button" onClick={() => setCondForm((f) => ({ ...f, activeDays: (f.activeDays || []).includes(i) ? (f.activeDays || []).filter((x) => x !== i) : [...(f.activeDays || []), i] }))} className={`px-3 py-1.5 rounded-lg text-xs font-bold border-2 ${(condForm.activeDays || []).includes(i) ? 'bg-gold-600 text-white border-gold-600' : 'border-gray-200 text-gray-600'}`}>{d}</button>
                ))}
              </div>
            </Field>
          )}
          {condForm.trigger === 'product_purchase' && (
            <Field label="Produk Pemicu">
              <div className="max-h-32 overflow-y-auto border border-gray-200 rounded-xl p-2 space-y-1">
                {products.map((p) => (
                  <label key={p.id} className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 rounded-lg px-2 py-1">
                    <input type="checkbox" checked={(condForm.applicableProductIds || []).includes(p.id)} onChange={(e) => setCondForm((f) => ({ ...f, applicableProductIds: e.target.checked ? [...(f.applicableProductIds || []), p.id] : (f.applicableProductIds || []).filter((x) => x !== p.id) }))} className="accent-gold-600" />
                    <span className="text-sm text-gray-700">{p.name}</span>
                  </label>
                ))}
              </div>
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
        </div>
      </Modal>

      <Modal
        open={!!delId}
        onClose={() => setDelId(null)}
        size="sm"
        footer={
          <>
            <Button variant="secondary" className="flex-1" onClick={() => setDelId(null)}>Batal</Button>
            <Button variant="danger" className="flex-1" onClick={() => del(delId!)}>Ya, Hapus</Button>
          </>
        }
      >
        <div className="text-center">
          <div className="w-14 h-14 bg-red-100 rounded-2xl flex items-center justify-center mx-auto mb-4"><Trash2 className="w-7 h-7 text-red-500" /></div>
          <h3 className="text-xl font-black text-gray-900 mb-2">Hapus Pelanggan?</h3>
          <p className="text-sm text-gray-400">Data poin dan riwayat akan terhapus permanen.</p>
        </div>
      </Modal>
    </>
  )
}
