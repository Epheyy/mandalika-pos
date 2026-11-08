import type { ReactNode } from 'react'
import type { components } from '@mandalika/api'
import { variantLabel } from '@mandalika/types'
import type { ProfileStatus } from '../hooks/useCustomerProfile'
import { Sheet } from '../components/ui/Sheet'
import { Button } from '../components/ui/Button'
import { formatRupiah } from './pricing'
import { compactRupiah } from './compactMoney'
import { formatPoints } from './customerFinder'
import { methodDisplayLabel } from '../lib/queuedSales'
import {
  daysSinceLast, knownTier, pitchLines, type CustomerProfile, type LocalHistoryOrder,
} from './customerProfile'

type Customer = components['schemas']['Customer']
type Line = components['schemas']['CustomerProfileOrderLine']
type Frequent = components['schemas']['CustomerProfileFrequentItem']



interface CustomerProfileSheetProps {
  /** The customer whose profile is open; null keeps the sheet closed. */
  customer: Customer | null
  status: ProfileStatus
  profile: CustomerProfile | null
  /** This tablet's receipts for the customer: the history when the server cannot answer. */
  localOrders: LocalHistoryOrder[]
  loyaltyEnabled: boolean
  /** Live reward count from the cart preview, or null when it is not known (offline, not attached). */
  rewardsCount: number | null
  /** The customer is already on the sale. */
  attached: boolean
  now: number
  onRepeat: (lines: Line[]) => void
  onAddOne: (item: Frequent) => void
  onSelect: (customer: Customer) => void
  onClose: () => void
}

/** One stat tile; `tone` tints it (hadiah = teal, days = warn), as in the mock. */
function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'reward' | 'warn' }) {
  const palette = tone === 'reward' ? 'bg-reward-bg text-reward' : tone === 'warn' ? 'bg-warn-bg text-warn-strong' : 'bg-white text-ink-900'
  return (
    <div className={`min-w-0 flex-1 rounded-control px-2.5 py-2 ${palette}`}>
      <p className="tnum truncate text-[1.0625rem] font-bold">{value}</p>
      <p className={`truncate text-[0.75rem] ${tone ? '' : 'text-ink-500'}`}>{label}</p>
    </div>
  )
}

function itemsText(lines: readonly Line[]): string {
  return lines.map((l) => `${l.name}${variantLabel(l.size) ? ` ${variantLabel(l.size)}` : ''} ×${l.qty}`).join(', ')
}

const dateText = (iso: string) => {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) : ''
}

const monthYear = (iso: string | null | undefined): string => {
  const t = iso ? Date.parse(iso) : Number.NaN
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('id-ID', { month: 'short', year: 'numeric' }) : ''
}

/** F23: the customer to attach from Profil. The sheet shows the freshly fetched points balance, so the cart must
 *  get that balance too (not the possibly stale object the search or cache returned). */
export function freshCustomer(customer: Customer, profile: { customer: { id: string; points: number } } | null): Customer {
  return profile && profile.customer.id === customer.id ? { ...customer, points: profile.customer.points } : customer
}

interface HistoryRow { id: string; number: string; at: string; total: number; lines: Line[]; paymentMethod?: string; outletCode?: string }

/** Second line of a purchase card: date, outlet (server only), payment method, and the reward given. */
function orderMeta(o: HistoryRow): string {
  const gifts = o.lines.filter((l) => l.free).map((l) => l.name)
  return [
    dateText(o.at), o.outletCode ?? null, o.paymentMethod ? methodDisplayLabel(o.paymentMethod) : null,
    gifts.length > 0 ? `hadiah ${gifts.join(', ')}` : null,
  ].filter((p) => p).join(' · ')
}

/** W3b Profil Pelanggan (B3, D-25): who they are, what to talk about, what they bought, and a one-tap repeat. Server
 *  data is online-only; without it the sheet shows the local record and this tablet's receipts. */
export function CustomerProfileSheet({
  customer, status, profile, localOrders, loyaltyEnabled, rewardsCount, attached, now, onRepeat, onAddOne, onSelect, onClose,
}: CustomerProfileSheetProps) {
  const server = status === 'ready' && profile !== null
  const tier = server ? profile.customer.tier : customer ? knownTier(customer) : null
  const orders: HistoryRow[] = server
    ? profile.lastOrders.map((o) => ({ id: o.id, number: o.number, at: o.at, total: o.total, lines: o.lines, paymentMethod: o.paymentMethod, outletCode: o.outletCode }))
    : localOrders
  const pitch = server ? pitchLines(profile.pitch, now) : []
  const since = server ? daysSinceLast(profile, now) : null
  const rewards = rewardsCount ?? (server ? profile.rewardsAvailable : null)
  const sinceText = server ? monthYear(profile.customer.since) : monthYear(customer?.createdAt)
  const txCount = server ? profile.customer.orderCount : (customer?.visitCount ?? 0)
  const identity = customer
    ? [customer.phone, sinceText ? `pelanggan sejak ${sinceText}` : null, txCount > 0 ? `${txCount} transaksi` : null].filter((p) => p).join(' · ')
    : ''
  return (
    <Sheet
      open={customer !== null} onClose={onClose} variant="side" z={60} maxWidth="max-w-[560px]" panelClassName="flex flex-col overflow-hidden"
      header title="Profil Pelanggan"
    >
      {customer && (
        <>
          <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
            <div className="flex items-center gap-3">
              <span aria-hidden="true" className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-reward text-lg font-bold text-white">
                {(customer.name || '?').charAt(0).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[1.0625rem] font-bold text-ink-900">{customer.name}</span>
                  {tier && <span className="flex-shrink-0 rounded-chip bg-paper-1 px-2 py-0.5 text-[0.75rem] font-semibold text-ink-700">{tier}</span>}
                </p>
                <p className="truncate text-[0.8125rem] text-ink-500">{identity}</p>
              </div>
            </div>

            {status === 'loading' && <p className="text-[0.8125rem] text-ink-500">Memuat riwayat…</p>}

            {server && (
              <div className="flex gap-2 rounded-control bg-paper-1 p-1.5">
                {loyaltyEnabled && <Stat label="poin" value={formatPoints(profile.customer.points)} />}
                {loyaltyEnabled && <Stat label="tersedia" value={`${rewards ?? 0} hadiah`} tone={rewards ? 'reward' : undefined} />}
                <Stat label="total belanja" value={compactRupiah(profile.customer.totalSpend)} />
                <Stat label="sejak terakhir" value={since === null ? '—' : `${since} hari`} tone={since !== null && since >= 30 ? 'warn' : undefined} />
              </div>
            )}
            {!server && status !== 'loading' && loyaltyEnabled && (
              <div className="flex gap-2 rounded-control bg-paper-1 p-1.5"><Stat label="poin" value={formatPoints(customer.points)} /></div>
            )}

            {pitch.length > 0 && (
              <section aria-label="Bahan obrolan" className="rounded-control bg-info-bg p-3">
                <h3 className="text-[0.75rem] font-bold text-info">Bahan obrolan</h3>
                {pitch.map((p) => <p key={p} className="mt-1 text-[0.9375rem] text-ink-900">{p}</p>)}
              </section>
            )}

            <section aria-label="Pembelian terakhir">
              <h3 className="pb-2 text-[0.9375rem] font-bold text-ink-900">Pembelian terakhir</h3>
              {orders.length === 0 ? (
                <p className="text-[0.8125rem] text-ink-500">{status === 'loading' ? 'Memuat…' : 'Belum ada pembelian tercatat.'}</p>
              ) : (
                orders.map((o) => {
                  const paid = o.lines.filter((l) => !l.free)
                  return (
                    <div key={o.id} className="surface-card mb-2 flex items-center gap-3 rounded-control px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[0.9375rem] font-bold text-ink-900">{itemsText(o.lines) || o.number}</p>
                        <p className="truncate text-[0.8125rem] text-ink-500">{orderMeta(o)}</p>
                      </div>
                      <span className="flex-shrink-0 text-[0.9375rem] font-bold text-ink-900 tnum">{formatRupiah(o.total)}</span>
                      <Button variant="ghost" disabled={paid.length === 0} onClick={() => onRepeat(o.lines)} aria-label={`Ulangi ${o.number}`} className="flex-shrink-0 bg-paper-1!">Ulangi</Button>
                    </div>
                  )
                })
              )}
            </section>

            {server && profile.frequentItems.length > 0 && (
              <section aria-label="Sering dibeli">
                <h3 className="pb-2 text-[0.9375rem] font-bold text-ink-900">Sering dibeli</h3>
                <div className="flex flex-wrap gap-2">
                  {profile.frequentItems.map((f) => (
                    <button
                      key={`${f.productId}|${f.size}`} type="button" onClick={() => onAddOne(f)}
                      className="touch rounded-chip border border-paper-2 bg-white px-3 text-[0.875rem] font-semibold text-ink-900 active:bg-paper-1"
                    >
                      {f.name}{variantLabel(f.size) ? ` ${variantLabel(f.size)}` : ''} <span className="text-ink-500">×{f.count}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {server && profile.notes.length > 0 && (
              <section aria-label="Catatan">
                <h3 className="pb-2 text-[0.9375rem] font-bold text-ink-900">Catatan</h3>
                {profile.notes.map((n, i) => (
                  <p key={`${n.at}-${i}`} className="text-[0.9375rem] text-ink-900"><span className="text-ink-500">{dateText(n.at)} · {n.kind}</span> {n.text}</p>
                ))}
              </section>
            )}

            {!server && status !== 'loading' && <p className="rounded-control bg-info-bg px-3 py-2 text-[0.8125rem] font-semibold text-info">Riwayat lengkap butuh internet.</p>}
          </div>
          <div className="flex-shrink-0 border-t border-paper-2 p-3">
            {attached ? (
              <p className="py-3 text-center text-[0.9375rem] font-semibold text-ink-700">Sudah dipilih untuk transaksi ini</p>
            ) : (
              <button
                type="button" onClick={() => onSelect(freshCustomer(customer, server ? profile : null))}
                className="bar-primary press-bar flex min-h-14 w-full items-center justify-between rounded-control px-4 text-[0.9375rem] font-bold"
              >
                <span>Pilih untuk transaksi ini</span>
                <span aria-hidden="true" className="text-xl">›</span>
              </button>
            )}
          </div>
        </>
      )}
    </Sheet>
  )
}
