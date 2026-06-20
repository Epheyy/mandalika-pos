import { useState } from 'react'
import type { Customer, Order, RewardGrant } from '@mandalika/api'
import { format, parseISO } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import {
  ArrowLeft, Edit2, Trash2, Phone, Mail, Star, ShoppingBag,
  ChevronDown, ChevronUp, Gift, Cake, CalendarHeart, Tag, History, Plus,
} from 'lucide-react'
import type { Tag as TagType, Interaction } from '@mandalika/api'
import { api } from '../../api'
import { useAuth } from '../../auth'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { TableSkeleton } from '../../components/Skeleton'
import { BRAND } from '../../lib/brand'
import { Button } from '../../ui/Button'
import { Modal } from '../../ui/Modal'
import { Card } from '../../ui/Card'
import { Badge } from '../../ui/Badge'
import { IconButton } from '../../ui/IconButton'
import { EmptyState } from '../../ui/EmptyState'
import { Pagination } from '../../ui/Pagination'
import { tagChipClasses } from './tagColors'
import {
  INTERACTION_TYPES, interactionLabel, interactionChipClasses, daysUntilRecurrence,
  type InteractionType,
} from './interactionTypes'
import { pointTypeLabel, pointTypeChipClasses } from './pointTypes'
import { rewardGrantSummary } from './rewardTypes'
import { TagManager } from './TagManager'

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
  const cq = usePolledQuery<Customer | null>(
    () => api.getCustomer(customerId).catch(() => null),
    [customerId],
  )
  const oq = usePolledQuery<Order[]>(
    () => api.listOrders({ customerId, limit: 200 }).then((r) => r.data),
    [customerId],
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

      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-gold-50 flex items-center justify-center flex-shrink-0">
            <span className="text-xl font-black text-gold-600">{c.name.charAt(0).toUpperCase()}</span>
          </div>
          <div>
            <h1 className="text-2xl font-black text-gray-900">{c.name}</h1>
            {c.segment && (
              <span className={`inline-block mt-1 px-2.5 py-1 text-xs font-bold rounded-full border ${tagChipClasses(c.segment.color)}`}>{c.segment.name}</span>
            )}
            {(() => {
              const db = daysUntilRecurrence(c.birthday)
              const da = daysUntilRecurrence(c.anniversary)
              const soon: string[] = []
              if (db !== null && db <= 30) soon.push(`🎂 Ulang tahun ${db === 0 ? 'hari ini' : `dalam ${db} hari`}`)
              if (da !== null && da <= 30) soon.push(`💍 Hari jadi ${da === 0 ? 'hari ini' : `dalam ${da} hari`}`)
              return soon.map((s) => (
                <span key={s} className="inline-block mt-1 ml-1 px-2.5 py-1 text-xs font-bold rounded-full border bg-amber-100 text-amber-800 border-amber-200">{s}</span>
              ))
            })()}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" icon={<Edit2 className="w-4 h-4" />} onClick={() => onEdit(c)}>Edit</Button>
          <IconButton tone="danger" onClick={() => onDelete(c.id)}><Trash2 className="w-4 h-4" /></IconButton>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Left: profile */}
        <Card className="p-5 space-y-3 lg:col-span-1">
          <h3 className="font-black text-gray-900 text-sm">Profil</h3>
          <div className="flex items-center gap-2 text-sm text-gray-600"><Phone className="w-4 h-4 text-gray-400" /> {c.phone}</div>
          <div className="flex items-center gap-2 text-sm text-gray-600"><Mail className="w-4 h-4 text-gray-400" /> {c.email || '—'}</div>
          <div className="flex items-center gap-2 text-sm text-gray-600"><Cake className="w-4 h-4 text-gray-400" /> Ulang Tahun: {fmtDate(c.birthday)}</div>
          <div className="flex items-center gap-2 text-sm text-gray-600"><CalendarHeart className="w-4 h-4 text-gray-400" /> Hari Jadi: {fmtDate(c.anniversary)}</div>
          <div className="pt-2 border-t border-gray-100">
            <p className="text-xs font-bold text-gray-400 mb-1">Catatan</p>
            <p className="text-sm text-gray-600 whitespace-pre-wrap">{c.notes || '—'}</p>
          </div>
          {/* Tags (SP-CRM-4) */}
          <div className="pt-2 border-t border-gray-100 space-y-2">
            <div className="flex items-center justify-between">
              <p className="flex items-center gap-1.5 text-xs font-bold text-gray-400"><Tag className="w-3.5 h-3.5" /> Tag</p>
              <button type="button" className="text-xs font-bold text-gold-600 hover:text-gold-700" onClick={() => setTagModalOpen(true)}>Kelola</button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {cTags.map((t) => (
                <span key={t.id} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold border ${tagChipClasses(t.color)}`}>
                  {t.name}
                  <button type="button" aria-label={`Lepas ${t.name}`} disabled={tagBusy} onClick={() => void toggleTag(t.id)} className="hover:opacity-70 disabled:opacity-40">×</button>
                </span>
              ))}
              {allTags.flatMap((t) =>
                cTags.some((ct) => ct.id === t.id)
                  ? []
                  : [
                      <button key={t.id} type="button" disabled={tagBusy} onClick={() => void toggleTag(t.id)}
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border border-dashed ${tagChipClasses(t.color)} opacity-50 hover:opacity-100 disabled:opacity-30`}>
                        + {t.name}
                      </button>,
                    ],
              )}
              {allTags.length === 0 && <span className="text-xs text-gray-300 italic">Belum ada tag — klik Kelola</span>}
            </div>
          </div>
        </Card>

        {/* Right: stats + history */}
        <div className="lg:col-span-2 space-y-5">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Card className="p-4">
              <p className="text-xs text-gray-400 font-bold">Total Belanja</p>
              <p className="text-lg font-black text-gray-900">{BRAND.currency.format(c.totalSpent)}</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs text-gray-400 font-bold">Kunjungan</p>
              <p className="text-lg font-black text-gray-900">{c.visitCount}</p>
            </Card>
            {loyaltyEnabled && (
              <Card className="p-4">
                <p className="text-xs text-gray-400 font-bold">Poin</p>
                <p className="flex items-center gap-1 text-lg font-black text-gold-600"><Star className="w-4 h-4" />{c.points.toLocaleString('id-ID')}</p>
              </Card>
            )}
            <Card className="p-4">
              <p className="text-xs text-gray-400 font-bold">Kunjungan Terakhir</p>
              <p className="text-sm font-bold text-gray-900">{fmtDate(c.lastVisit)}</p>
            </Card>
          </div>

          <Card className="overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2">
              <ShoppingBag className="w-4 h-4 text-gray-400" />
              <h3 className="font-black text-gray-900 text-sm">Riwayat Pembelian</h3>
            </div>
            {oq.loading ? (
              <TableSkeleton />
            ) : orders.length === 0 ? (
              <EmptyState icon={<ShoppingBag />} title="Belum ada transaksi" />
            ) : (
              <div className="divide-y divide-gray-50">
                {orders.map((o) => (
                  <div key={o.id}>
                    <div
                      role="button"
                      tabIndex={0}
                      className="px-5 py-3 flex items-center gap-3 hover:bg-gray-50 cursor-pointer"
                      onClick={() => setExpanded(expanded === o.id ? null : o.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setExpanded(expanded === o.id ? null : o.id)
                        }
                      }}
                    >
                      <div className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 ${o.status === 'refunded' ? 'bg-red-50' : 'bg-gold-50'}`}>
                        <ShoppingBag className={`w-4 h-4 ${o.status === 'refunded' ? 'text-red-400' : 'text-gold-600'}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-bold text-gray-900 text-sm">{o.orderNumber}</p>
                        <p className="text-xs text-gray-400">{format(parseISO(o.createdAt), 'dd MMM yyyy HH:mm', { locale: idLocale })} · <span className="capitalize">{o.paymentMethod}</span></p>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <Badge tone={o.status === 'refunded' ? 'danger' : 'success'}>{o.status === 'refunded' ? 'Refund' : 'Selesai'}</Badge>
                        <p className="font-black text-gray-900 text-sm">{BRAND.currency.format(o.total)}</p>
                        {expanded === o.id ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                      </div>
                    </div>
                    {expanded === o.id && (
                      <div className="px-5 pb-3 bg-gray-50 border-t border-gray-100">
                        <div className="pt-3 space-y-1">
                          {o.items.map((it, i) => (
                            <div key={`${it.productId}-${it.variantSize}-${i}`} className="flex justify-between text-sm">
                              <span className="text-gray-600">{it.productName} {it.variantSize} ×{it.quantity}</span>
                              <span className="font-bold text-gray-900">{BRAND.currency.format(it.subtotal)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>

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
            {rewardGrants.length > 0 && (
              <div className="border-t border-gray-100 px-4 py-3">
                <p className="text-xs font-bold text-gray-500 mb-2">Reward Produk</p>
                <ul className="space-y-1">
                  {rewardGrants.map((g) => (
                    <li key={g.id} className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-gray-700">{g.conditionName}</span>
                      <span className="text-gray-400">
                        {rewardGrantSummary(g.rewardProductIds)}
                        {g.orderNumber ? ` · ${g.orderNumber}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
        </div>
      </div>

      <Modal open={tagModalOpen} onClose={() => setTagModalOpen(false)} title="Kelola Tag">
        <TagManager tags={allTags} onChange={() => void tagsQ.refetch()} />
      </Modal>
    </div>
  )
}
