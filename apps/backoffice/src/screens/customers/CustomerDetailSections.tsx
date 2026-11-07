import type { Customer, Order, RewardGrant, Tag as TagType } from '@mandalika/api'
import { format, parseISO } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import {
  Edit2, Trash2, Phone, Mail, Star, ShoppingBag,
  ChevronDown, ChevronUp, Cake, CalendarHeart, Tag,
} from 'lucide-react'
import { TableSkeleton } from '../../components/Skeleton'
import { BRAND } from '../../lib/brand'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { Badge } from '../../ui/Badge'
import { orderIconClasses, orderStatusLabel, orderStatusTone } from '../../lib/orderStatus'
import { IconButton } from '../../ui/IconButton'
import { EmptyState } from '../../ui/EmptyState'
import { tagChipClasses } from './tagColors'
import { methodLabel } from '../../lib/splitPayment'
import { daysUntilRecurrence } from './interactionTypes'
import { rewardGrantSummary } from './rewardTypes'

const fmtDate = (d?: string | null) =>
  d ? format(parseISO(d), 'dd MMM yyyy', { locale: idLocale }) : '—'

interface DetailHeaderProps {
  customer: Customer
  onEdit: (c: Customer) => void
  onDelete: (c: Customer) => void
}

export function DetailHeader({ customer: c, onEdit, onDelete }: DetailHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex items-center gap-4">
        <div className="w-14 h-14 rounded-2xl bg-paper-1 flex items-center justify-center flex-shrink-0">
          <span className="text-xl font-black text-brand-strong">{c.name.charAt(0).toUpperCase()}</span>
        </div>
        <div>
          <h1 className="text-2xl font-black text-ink-900">{c.name}</h1>
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
              <span key={s} className="inline-block mt-1 ml-1 px-2.5 py-1 text-xs font-bold rounded-full border bg-warn-bg text-warn-strong border-warn/30">{s}</span>
            ))
          })()}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="secondary" icon={<Edit2 className="w-4 h-4" />} onClick={() => onEdit(c)}>Edit</Button>
        <IconButton tone="danger" label={`Hapus pelanggan ${c.name}`} onClick={() => onDelete(c)}><Trash2 className="w-4 h-4" /></IconButton>
      </div>
    </div>
  )
}

interface ProfileCardProps {
  customer: Customer
  allTags: TagType[]
  cTags: TagType[]
  tagBusy: boolean
  toggleTag: (tagId: string) => void
  onManageTags: () => void
}

export function ProfileCard({ customer: c, allTags, cTags, tagBusy, toggleTag, onManageTags }: ProfileCardProps) {
  return (
    <Card className="p-5 space-y-3 lg:col-span-1">
      <h3 className="font-black text-ink-900 text-sm">Profil</h3>
      <div className="flex items-center gap-2 text-sm text-ink-700"><Phone className="w-4 h-4 text-ink-500" /> {c.phone}</div>
      <div className="flex items-center gap-2 text-sm text-ink-700"><Mail className="w-4 h-4 text-ink-500" /> {c.email || '—'}</div>
      <div className="flex items-center gap-2 text-sm text-ink-700"><Cake className="w-4 h-4 text-ink-500" /> Ulang Tahun: {fmtDate(c.birthday)}</div>
      <div className="flex items-center gap-2 text-sm text-ink-700"><CalendarHeart className="w-4 h-4 text-ink-500" /> Hari Jadi: {fmtDate(c.anniversary)}</div>
      <div className="pt-2 border-t border-paper-2">
        <p className="text-xs font-bold text-ink-500 mb-1">Catatan</p>
        <p className="text-sm text-ink-700 whitespace-pre-wrap">{c.notes || '—'}</p>
      </div>
      {/* Tags (SP-CRM-4) */}
      <div className="pt-2 border-t border-paper-2 space-y-2">
        <div className="flex items-center justify-between">
          <p className="flex items-center gap-1.5 text-xs font-bold text-ink-500"><Tag className="w-3.5 h-3.5" /> Tag</p>
          <button type="button" className="text-xs font-bold text-brand-strong" onClick={onManageTags}>Kelola</button>
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
          {allTags.length === 0 && <span className="text-xs text-ink-500 italic">Belum ada tag — klik Kelola</span>}
        </div>
      </div>
    </Card>
  )
}

interface CustomerStatsCardsProps {
  customer: Customer
  loyaltyEnabled: boolean
}

export function CustomerStatsCards({ customer: c, loyaltyEnabled }: CustomerStatsCardsProps) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <Card className="p-4">
        <p className="text-xs text-ink-500 font-bold">Total Belanja</p>
        <p className="text-lg font-black text-ink-900">{BRAND.currency.format(c.totalSpent)}</p>
      </Card>
      <Card className="p-4">
        <p className="text-xs text-ink-500 font-bold">Kunjungan</p>
        <p className="text-lg font-black text-ink-900">{c.visitCount}</p>
      </Card>
      {loyaltyEnabled && (
        <Card className="p-4">
          <p className="text-xs text-ink-500 font-bold">Poin</p>
          <p className="flex items-center gap-1 text-lg font-black text-brand-strong"><Star className="w-4 h-4" />{c.points.toLocaleString('id-ID')}</p>
        </Card>
      )}
      <Card className="p-4">
        <p className="text-xs text-ink-500 font-bold">Kunjungan Terakhir</p>
        <p className="text-sm font-bold text-ink-900">{fmtDate(c.lastVisit)}</p>
      </Card>
    </div>
  )
}

interface PurchaseHistoryCardProps {
  orders: Order[]
  loading: boolean
  expanded: string | null
  setExpanded: (id: string | null) => void
}

export function PurchaseHistoryCard({ orders, loading, expanded, setExpanded }: PurchaseHistoryCardProps) {
  return (
    <Card className="overflow-clip">
      <div className="px-5 py-3 border-b border-paper-2 flex items-center gap-2">
        <ShoppingBag className="w-4 h-4 text-ink-500" />
        <h3 className="font-black text-ink-900 text-sm">Riwayat Pembelian</h3>
      </div>
      {loading ? (
        <TableSkeleton />
      ) : orders.length === 0 ? (
        <EmptyState icon={<ShoppingBag />} title="Belum ada transaksi" />
      ) : (
        <div className="divide-y divide-paper-1">
          {orders.map((o) => (
            <div key={o.id}>
              <div
                role="button"
                tabIndex={0}
                className="px-5 py-3 flex items-center gap-3 hover:bg-paper-1 cursor-pointer"
                onClick={() => setExpanded(expanded === o.id ? null : o.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setExpanded(expanded === o.id ? null : o.id)
                  }
                }}
              >
                <div className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 ${orderIconClasses(o.status).tile}`}>
                  <ShoppingBag className={`w-4 h-4 ${orderIconClasses(o.status).glyph}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-ink-900 text-sm">{o.orderNumber}</p>
                  <p className="text-xs text-ink-500">{format(parseISO(o.createdAt), 'dd MMM yyyy HH:mm', { locale: idLocale })} · {methodLabel(o.paymentMethod)}</p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <Badge tone={orderStatusTone(o.status)}>{orderStatusLabel(o.status)}</Badge>
                  <p className="font-black text-ink-900 text-sm">{BRAND.currency.format(o.total)}</p>
                  {expanded === o.id ? <ChevronUp className="w-4 h-4 text-ink-500" /> : <ChevronDown className="w-4 h-4 text-ink-500" />}
                </div>
              </div>
              {expanded === o.id && (
                <div className="px-5 pb-3 bg-paper-1 border-t border-paper-2">
                  <div className="pt-3 space-y-1">
                    {o.items.map((it, i) => (
                      <div key={`${it.productId}-${it.variantSize}-${i}`} className="flex justify-between text-sm">
                        <span className="text-ink-700">{it.productName} {it.variantSize} ×{it.quantity}</span>
                        <span className="font-bold text-ink-900">{BRAND.currency.format(it.subtotal)}</span>
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
  )
}

interface RewardGrantsListProps {
  rewardGrants: RewardGrant[]
}

export function RewardGrantsList({ rewardGrants }: RewardGrantsListProps) {
  if (rewardGrants.length === 0) return null
  return (
    <div className="border-t border-paper-2 px-4 py-3">
      <p className="text-xs font-bold text-ink-500 mb-2">Reward Produk</p>
      <ul className="space-y-1">
        {rewardGrants.map((g) => (
          <li key={g.id} className="flex items-center justify-between text-xs">
            <span className="font-semibold text-ink-700">{g.conditionName}</span>
            <span className="text-ink-500">
              {rewardGrantSummary(g.rewardProductIds)}
              {g.orderNumber ? ` · ${g.orderNumber}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
