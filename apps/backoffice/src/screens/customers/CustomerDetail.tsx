import { useState } from 'react'
import type { Customer, Order } from '@mandalika/api'
import { format, parseISO } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import {
  ArrowLeft, Edit2, Trash2, Phone, Mail, Star, ShoppingBag,
  ChevronDown, ChevronUp, Gift, Cake, CalendarHeart, Tag, History,
} from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { TableSkeleton } from '../../components/Skeleton'
import { BRAND } from '../../lib/brand'
import { Button, Card, Badge, IconButton, EmptyState } from '../../ui'

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
  const [expanded, setExpanded] = useState<string | null>(null)
  const c = cq.data

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
          {/* Reserved for SP-CRM-2 */}
          <div className="pt-2 border-t border-gray-100">
            <p className="flex items-center gap-1.5 text-xs font-bold text-gray-300"><Tag className="w-3.5 h-3.5" /> Tag &amp; Segmen — segera</p>
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
                            <div key={i} className="flex justify-between text-sm">
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
    </div>
  )
}
