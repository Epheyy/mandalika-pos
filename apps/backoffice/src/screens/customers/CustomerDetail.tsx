import { useState } from 'react'
import { fetchAllPages, type Customer, type Order, type RewardGrant } from '@mandalika/api'
import { format, parseISO } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import {
  ArrowLeft, Star, Gift, History, Plus, Trash2,
} from 'lucide-react'
import type { Tag as TagType, Interaction } from '@mandalika/api'
import { api } from '../../api'
import { useOutlet } from '../../outlet'
import { useAuth } from '../../auth'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { TableSkeleton } from '../../components/Skeleton'
import { Button } from '../../ui/Button'
import { Modal } from '../../ui/Modal'
import { Card } from '../../ui/Card'
import { IconButton } from '../../ui/IconButton'
import { EmptyState } from '../../ui/EmptyState'
import { Pagination } from '../../ui/Pagination'
import {
  INTERACTION_TYPES, interactionLabel, interactionChipClasses,
  type InteractionType,
} from './interactionTypes'
import { pointTypeLabel, pointTypeChipClasses } from './pointTypes'
import { TagManager } from './TagManager'
import {
  DetailHeader, ProfileCard, CustomerStatsCards, PurchaseHistoryCard, RewardGrantsList,
} from './CustomerDetailSections'

interface CustomerDetailProps {
  customerId: string
  loyaltyEnabled: boolean
  onBack: () => void
  onEdit: (c: Customer) => void
  onDelete: (id: string) => void
}

const fmtDate = (d?: string | null) =>
  d ? format(parseISO(d), 'dd MMM yyyy', { locale: idLocale }) : '—'

const todayISO = () => new Date().toISOString().slice(0, 10)

export default function CustomerDetail({
  customerId, loyaltyEnabled, onBack, onEdit, onDelete,
}: CustomerDetailProps) {
  const { outletId } = useOutlet()
  const cq = usePolledQuery<Customer | null>(
    () => api.getCustomer(customerId).catch(() => null),
    [customerId],
  )
  const oq = usePolledQuery<Order[]>(
    () => fetchAllPages((page, limit) => api.listOrders({ customerId, page, limit })),
    [customerId, outletId],
  )
  const tagsQ = usePolledQuery<TagType[]>(() => api.listTags(), [])
  const allTags = tagsQ.data ?? []
  const [tagModalOpen, setTagModalOpen] = useState(false)
  const [tagBusy, setTagBusy] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const c = cq.data

  const toggleTag = async (tagId: string) => {
    if (!c || tagBusy) return
    setTagBusy(true)
    const current = (c.tags ?? []).map((t) => t.id)
    const next = current.includes(tagId) ? current.filter((x) => x !== tagId) : [...current, tagId]
    try {
      await api.setCustomerTags(c.id, next)
      await cq.refetch()
    } catch { /* surfaced on next load; non-blocking */ } finally {
      setTagBusy(false)
    }
  }

  // Interaction timeline (SP-CRM-6)
  const [iPage, setIPage] = useState(1)
  const [iLimit, setILimit] = useState(25)
  const iq = usePolledQuery(
    () => api.listInteractions(customerId, iPage, iLimit),
    [customerId, iPage, iLimit],
  )
  const interactions = iq.data?.data ?? []
  const iTotal = iq.data?.meta?.total ?? 0
  const iTotalPages = Math.max(1, Math.ceil(iTotal / iLimit))

  const [iType, setIType] = useState<InteractionType>('catatan')
  const [iDate, setIDate] = useState(() => todayISO())
  const [iNote, setINote] = useState('')
  const [iBusy, setIBusy] = useState(false)

  const addInteraction = async () => {
    if (iBusy) return
    setIBusy(true)
    try {
      await api.createInteraction(customerId, { type: iType, interactionDate: iDate, note: iNote })
      setIType('catatan'); setIDate(todayISO()); setINote('')
      if (iPage !== 1) {
        setIPage(1)          // deps change drives the page-1 refetch
      } else {
        await iq.refetch()   // already on page 1: deps won't change, so refetch explicitly
      }
    } catch { /* surfaced on next load */ } finally {
      setIBusy(false)
    }
  }
  const removeInteraction = async (iid: string) => {
    if (iBusy) return
    setIBusy(true)
    try { await api.deleteInteraction(customerId, iid); await iq.refetch() }
    catch { /* non-blocking */ } finally { setIBusy(false) }
  }

  // Points ledger (SP-CRM-7)
  const { user } = useAuth()
  const canAdjust = user?.role === 'admin' || (user?.permissions ?? []).includes('manage_settings')
  const [ptPage, setPtPage] = useState(1)
  const ptLimit = 25
  const ptq = usePolledQuery(
    () => api.listPointTransactions(customerId, ptPage, ptLimit),
    [customerId, ptPage],
  )
  const ptx = ptq.data?.data ?? []
  const ptTotal = ptq.data?.meta?.total ?? 0
  const rgq = usePolledQuery(
    () => api.listRewardGrants(customerId),
    [customerId],
  )
  const rewardGrants: RewardGrant[] = rgq.data ?? []

  const [adjOpen, setAdjOpen] = useState(false)
  const [adjAmount, setAdjAmount] = useState('')   // signed integer string
  const [adjReason, setAdjReason] = useState('')
  const [adjBusy, setAdjBusy] = useState(false)
  const [adjErr, setAdjErr] = useState<string | null>(null)

  const submitAdjust = async () => {
    const n = Number(adjAmount.trim())
    if (!Number.isInteger(n) || n === 0) {
      setAdjErr('Jumlah harus bilangan bulat bukan nol')
      return
    }
    if (!adjReason.trim()) { setAdjErr('Alasan wajib diisi'); return }
    if (adjBusy) return
    setAdjBusy(true); setAdjErr(null)
    try {
      await api.adjustPoints(customerId, { points: n, reason: adjReason.trim() })
      setAdjOpen(false); setAdjAmount(''); setAdjReason('')
      const ledgerRefetch = ptPage === 1 ? ptq.refetch() : Promise.resolve()
      setPtPage(1)
      await Promise.all([ledgerRefetch, cq.refetch()])  // refresh ledger + balance
    } catch (e) {
      setAdjErr(e instanceof Error ? e.message : 'Gagal menyesuaikan poin')
    } finally {
      setAdjBusy(false)
    }
  }

  if (cq.loading && !c) {
    return (
      <div className="p-6">
        <button type="button" onClick={onBack} className="flex items-center gap-2 text-sm font-bold text-gray-500 hover:text-gray-900 mb-4">
          <ArrowLeft className="w-4 h-4" /> Kembali ke Pelanggan
        </button>
        <TableSkeleton />
      </div>
    )
  }
  if (!c) {
    return (
      <div className="p-6">
        <button type="button" onClick={onBack} className="flex items-center gap-2 text-sm font-bold text-gray-500 hover:text-gray-900 mb-4">
          <ArrowLeft className="w-4 h-4" /> Kembali ke Pelanggan
        </button>
        <Card><EmptyState icon={<Gift />} title="Pelanggan tidak ditemukan" /></Card>
      </div>
    )
  }

  const orders = oq.data ?? []
  const cTags = c.tags ?? []

  return (
    <div className="p-6 space-y-5">
      <button type="button" onClick={onBack} className="flex items-center gap-2 text-sm font-bold text-gray-500 hover:text-gray-900">
        <ArrowLeft className="w-4 h-4" /> Kembali ke Pelanggan
      </button>

      <DetailHeader customer={c} onEdit={onEdit} onDelete={onDelete} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Left: profile */}
        <ProfileCard
          customer={c}
          allTags={allTags}
          cTags={cTags}
          tagBusy={tagBusy}
          toggleTag={(tagId) => void toggleTag(tagId)}
          onManageTags={() => setTagModalOpen(true)}
        />

        {/* Right: stats + history */}
        <div className="lg:col-span-2 space-y-5">
          <CustomerStatsCards customer={c} loyaltyEnabled={loyaltyEnabled} />

          <PurchaseHistoryCard orders={orders} loading={oq.loading} expanded={expanded} setExpanded={setExpanded} />

          {/* Timeline Interaksi (SP-CRM-6) */}
          <Card className="overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2">
              <History className="w-4 h-4 text-gray-400" />
              <h3 className="font-black text-gray-900 text-sm">Timeline Interaksi</h3>
            </div>
            <div className="p-4 space-y-3 border-b border-gray-100 bg-gray-50">
              <div className="flex flex-wrap gap-2">
                <select value={iType} onChange={(e) => setIType(e.target.value as InteractionType)}
                  aria-label="Jenis interaksi"
                  className="px-2 py-1.5 text-sm rounded-lg border border-gray-200 bg-white">
                  {INTERACTION_TYPES.map((t) => <option key={t} value={t}>{interactionLabel(t)}</option>)}
                </select>
                <input type="date" value={iDate} onChange={(e) => setIDate(e.target.value)}
                  aria-label="Tanggal interaksi"
                  className="px-2 py-1.5 text-sm rounded-lg border border-gray-200 bg-white" />
              </div>
              <textarea value={iNote} onChange={(e) => setINote(e.target.value)} rows={2}
                placeholder="Catatan interaksi…"
                aria-label="Catatan interaksi"
                className="w-full px-2 py-1.5 text-sm rounded-lg border border-gray-200 bg-white" />
              <Button icon={<Plus className="w-4 h-4" />} loading={iBusy} disabled={iBusy} onClick={() => void addInteraction()}>
                Tambah Interaksi
              </Button>
            </div>
            {iq.loading && interactions.length === 0 ? (
              <TableSkeleton />
            ) : interactions.length === 0 ? (
              <EmptyState icon={<History />} title="Belum ada interaksi" />
            ) : (
              <div className="divide-y divide-gray-50">
                {interactions.map((it: Interaction) => (
                  <div key={it.id} className="px-5 py-3 flex items-start gap-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-bold border flex-shrink-0 ${interactionChipClasses(it.type)}`}>
                      {interactionLabel(it.type)}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-gray-400">{fmtDate(it.interactionDate)} · {it.createdByName || '—'}</p>
                      {it.note && <p className="text-sm text-gray-700 whitespace-pre-wrap">{it.note}</p>}
                    </div>
                    <IconButton tone="danger" disabled={iBusy} onClick={() => void removeInteraction(it.id)}><Trash2 className="w-4 h-4" /></IconButton>
                  </div>
                ))}
              </div>
            )}
            {iTotal > iLimit && (
              <div className="px-4 py-2 border-t border-gray-100">
                <Pagination
                  page={iPage} totalPages={iTotalPages} total={iTotal}
                  onChange={setIPage} pageSize={iLimit}
                  onPageSizeChange={(s) => { setILimit(s); setIPage(1) }}
                />
              </div>
            )}
          </Card>

          {/* Poin ledger (SP-CRM-7) */}
          <Card className="overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Star className="w-4 h-4 text-gold-500" />
                <h3 className="font-black text-gray-900 text-sm">Poin</h3>
                <span className="text-sm font-bold text-gold-600">{c.points.toLocaleString('id-ID')}</span>
              </div>
              {canAdjust && (
                <Button variant="secondary" onClick={() => { setAdjOpen(true); setAdjAmount(''); setAdjReason(''); setAdjErr(null) }}>Sesuaikan Poin</Button>
              )}
            </div>
            {adjOpen && (
              <div className="p-4 space-y-2 border-b border-gray-100 bg-gray-50">
                <div className="flex flex-wrap gap-2">
                  <input type="number" value={adjAmount} onChange={(e) => setAdjAmount(e.target.value)}
                    placeholder="+50 atau -20" aria-label="Jumlah penyesuaian poin" className="w-32 px-2 py-1.5 text-sm rounded-lg border border-gray-200 bg-white" />
                  <input value={adjReason} onChange={(e) => setAdjReason(e.target.value)}
                    placeholder="Alasan (mis. hadiah, koreksi)" aria-label="Alasan penyesuaian poin" className="flex-1 min-w-[12rem] px-2 py-1.5 text-sm rounded-lg border border-gray-200 bg-white" />
                </div>
                {adjErr && <p className="text-xs text-red-600">{adjErr}</p>}
                <div className="flex gap-2">
                  <Button loading={adjBusy} disabled={adjBusy} onClick={() => void submitAdjust()}>Simpan</Button>
                  <Button variant="secondary" onClick={() => { setAdjOpen(false); setAdjAmount(''); setAdjReason(''); setAdjErr(null) }}>Batal</Button>
                </div>
              </div>
            )}
            {ptq.loading && ptx.length === 0 ? (
              <TableSkeleton />
            ) : ptx.length === 0 ? (
              <EmptyState icon={<Star />} title="Belum ada transaksi poin" />
            ) : (
              <div className="divide-y divide-gray-50">
                {ptx.map((t) => (
                  <div key={t.id} className="px-5 py-3 flex items-center gap-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-bold border flex-shrink-0 ${pointTypeChipClasses(t.type)}`}>
                      {pointTypeLabel(t.type)}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-gray-400">{fmtDate(t.createdAt)}{t.orderNumber ? ` · ${t.orderNumber}` : ''}{t.createdByName ? ` · ${t.createdByName}` : ''}</p>
                      {t.reason && <p className="text-sm text-gray-700">{t.reason}</p>}
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className={`text-sm font-black ${t.points >= 0 ? 'text-green-600' : 'text-red-600'}`}>{t.points >= 0 ? '+' : ''}{t.points.toLocaleString('id-ID')}</p>
                      <p className="text-xs text-gray-400">{t.balanceAfter.toLocaleString('id-ID')}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {Math.ceil(ptTotal / ptLimit) > 1 && (
              <div className="px-4 py-2 border-t border-gray-100">
                <Pagination
                  page={ptPage} totalPages={Math.ceil(ptTotal / ptLimit)} total={ptTotal}
                  onChange={setPtPage} pageSize={ptLimit}
                  onPageSizeChange={() => { /* fixed 25 */ }}
                />
              </div>
            )}
            <RewardGrantsList rewardGrants={rewardGrants} />
          </Card>
        </div>
      </div>

      <Modal open={tagModalOpen} onClose={() => setTagModalOpen(false)} title="Kelola Tag">
        <TagManager tags={allTags} onChange={() => void tagsQ.refetch()} />
      </Modal>
    </div>
  )
}
