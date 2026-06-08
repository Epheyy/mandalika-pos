import { useState } from 'react'
import type { Customer, Order } from '@mandalika/api'
import { format, parseISO } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import {
  ArrowLeft, Edit2, Trash2, Phone, Mail, Star, ShoppingBag,
  ChevronDown, ChevronUp, Gift, Cake, CalendarHeart, Tag, History,
} from 'lucide-react'
import type { Tag as TagType } from '@mandalika/api'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { TableSkeleton } from '../../components/Skeleton'
import { BRAND } from '../../lib/brand'
import { Button, Card, Badge, IconButton, EmptyState, Modal } from '../../ui'
import { tagChipClasses } from './tagColors'
import { TagManager } from './TagManager'

interface CustomerDetailProps {
  customerId: string
  loyaltyEnabled: boolean
  tierEnabled: boolean
  tier: (spent: number) => { label: string; color: string }
  onBack: () => void
  onEdit: (c: Customer) => void
  onDelete: (id: string) => void
}

const fmtDate = (d?: string | null) =>
  d ? format(parseISO(d), 'dd MMM yyyy', { locale: idLocale }) : '—'

export default function CustomerDetail({
  customerId, loyaltyEnabled, tierEnabled, tier, onBack, onEdit, onDelete,
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
  const [expanded, setExpanded] = useState<string | null>(null)
  const c = cq.data

  const toggleTag = async (tagId: string) => {
    if (!c) return
    const current = (c.tags ?? []).map((t) => t.id)
    const next = current.includes(tagId) ? current.filter((x) => x !== tagId) : [...current, tagId]
    try {
      await api.setCustomerTags(c.id, next)
      await cq.refetch()
    } catch { /* surfaced on next load; non-blocking */ }
  }

  if (cq.loading && !c) {
    return (
      <div className="p-6">
        <button onClick={onBack} className="flex items-center gap-2 text-sm font-bold text-gray-500 hover:text-gray-900 mb-4">
          <ArrowLeft className="w-4 h-4" /> Kembali ke Pelanggan
        </button>
        <TableSkeleton />
      </div>
    )
  }
  if (!c) {
    return (
      <div className="p-6">
        <button onClick={onBack} className="flex items-center gap-2 text-sm font-bold text-gray-500 hover:text-gray-900 mb-4">
          <ArrowLeft className="w-4 h-4" /> Kembali ke Pelanggan
        </button>
        <Card><EmptyState icon={<Gift />} title="Pelanggan tidak ditemukan" /></Card>
      </div>
    )
  }

  const t = tier(c.totalSpent)
  const orders = oq.data ?? []

  return (
    <div className="p-6 space-y-5">
      <button onClick={onBack} className="flex items-center gap-2 text-sm font-bold text-gray-500 hover:text-gray-900">
        <ArrowLeft className="w-4 h-4" /> Kembali ke Pelanggan
      </button>

      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-gold-50 flex items-center justify-center flex-shrink-0">
            <span className="text-xl font-black text-gold-600">{c.name.charAt(0).toUpperCase()}</span>
          </div>
          <div>
            <h1 className="text-2xl font-black text-gray-900">{c.name}</h1>
            {tierEnabled && (
              <span className={`inline-block mt-1 px-2.5 py-1 text-xs font-bold rounded-lg ${t.color}`}>{t.label}</span>
            )}
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
              {(c.tags ?? []).map((t) => (
                <span key={t.id} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold border ${tagChipClasses(t.color)}`}>
                  {t.name}
                  <button type="button" aria-label={`Lepas ${t.name}`} onClick={() => void toggleTag(t.id)} className="hover:opacity-70">×</button>
                </span>
              ))}
              {allTags.filter((t) => !(c.tags ?? []).some((ct) => ct.id === t.id)).map((t) => (
                <button key={t.id} type="button" onClick={() => void toggleTag(t.id)}
                  className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border border-dashed ${tagChipClasses(t.color)} opacity-50 hover:opacity-100`}>
                  + {t.name}
                </button>
              ))}
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
                    <div className="px-5 py-3 flex items-center gap-3 hover:bg-gray-50 cursor-pointer" onClick={() => setExpanded(expanded === o.id ? null : o.id)}>
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

          {/* Reserved for SP-CRM-3 / SP-CRM-4 */}
          <Card className="p-5">
            <p className="flex items-center gap-1.5 text-xs font-bold text-gray-300"><History className="w-3.5 h-3.5" /> Poin (ledger) &amp; Timeline interaksi — segera</p>
          </Card>
        </div>
      </div>

      <Modal open={tagModalOpen} onClose={() => setTagModalOpen(false)} title="Kelola Tag">
        <TagManager tags={allTags} onChange={() => void tagsQ.refetch()} />
      </Modal>
    </div>
  )
}
