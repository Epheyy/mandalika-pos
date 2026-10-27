import type { ReactNode } from 'react'
import type { components } from '@mandalika/api'
import { variantLabel } from '@mandalika/types'
import type { ProfileStatus } from '../hooks/useCustomerProfile'
import { Sheet } from '../components/ui/Sheet'
import { Button } from '../components/ui/Button'
import { formatRupiah } from './pricing'
import {
  daysSinceLast, knownTier, pitchLines, relativeDays, type CustomerProfile, type LocalHistoryOrder, type Tier,
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

const TIER_CLASS: Record<Tier, string> = {
  Member: 'bg-paper-2 text-ink-700',
  Silver: 'bg-info-bg text-info',
  Gold: 'bg-warn-bg text-warn',
  Platinum: 'bg-promo-bg text-promo',
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-control bg-paper-1 px-3 py-2">
      <p className="tnum text-lg font-bold text-ink-900">{value}</p>
      <p className="text-[0.75rem] text-ink-500">{label}</p>
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

/** W3b Profil Pelanggan (B3, D-25): who they are, what to talk about, what they bought, and a one-tap repeat. Server
 *  data is online-only; without it the sheet shows the local record and this tablet's receipts. */
export function CustomerProfileSheet({
  customer, status, profile, localOrders, loyaltyEnabled, rewardsCount, attached, now, onRepeat, onAddOne, onSelect, onClose,
}: CustomerProfileSheetProps) {
  const server = status === 'ready' && profile !== null
  const tier: Tier | null = server ? profile.customer.tier : customer ? knownTier(customer) : null
  const orders = server ? profile.lastOrders.map((o) => ({ id: o.id, number: o.number, at: o.at, total: o.total, lines: o.lines })) : localOrders
  const pitch = server ? pitchLines(profile.pitch, now) : []
  const since = server ? daysSinceLast(profile, now) : null
  const rewards = rewardsCount ?? (server ? profile.rewardsAvailable : null)
  return (
    <Sheet
      open={customer !== null} onClose={onClose} variant="side" z={60} maxWidth="max-w-[560px]" panelClassName="flex flex-col overflow-hidden"
      title={<span className="block px-4 pt-4 pb-2 text-lg text-ink-900">Profil Pelanggan</span>}
    >
      {customer && (
        <>
          <div className="flex-1 space-y-4 overflow-y-auto px-4 pb-4">
            <div className="flex items-center gap-3">
              <span aria-hidden="true" className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-paper-2 text-lg font-bold text-ink-700">
                {(customer.name || '?').charAt(0).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[1.0625rem] font-bold text-ink-900">{customer.name}</p>
                <p className="truncate text-[0.8125rem] text-ink-500">{customer.phone}</p>
              </div>
              {tier && <span className={`flex-shrink-0 rounded-full px-2.5 py-1 text-[0.75rem] font-bold uppercase ${TIER_CLASS[tier]}`}>{tier}</span>}
            </div>

            {status === 'loading' && <p className="text-[0.8125rem] text-ink-500">Memuat riwayat…</p>}

            {server && (
              <div className="grid grid-cols-2 gap-2">
                {loyaltyEnabled && <Stat label="Poin" value={profile.customer.points} />}
                {loyaltyEnabled && <Stat label="Hadiah tersedia" value={rewards ?? 0} />}
                <Stat label="Total belanja" value={formatRupiah(profile.customer.totalSpend)} />
                <Stat label="Hari sejak terakhir" value={since ?? '—'} />
              </div>
            )}
            {!server && status !== 'loading' && loyaltyEnabled && (
              <div className="grid grid-cols-2 gap-2"><Stat label="Poin" value={customer.points} /></div>
            )}

            {pitch.length > 0 && (
              <section aria-label="Bahan obrolan" className="rounded-control border border-brand bg-paper-1 p-3">
                <h3 className="text-[0.8125rem] font-bold uppercase tracking-wide text-brand">Bahan obrolan</h3>
                {pitch.map((p) => <p key={p} className="mt-1 text-[0.9375rem] text-ink-900">{p}</p>)}
              </section>
            )}

            {server && profile.frequentItems.length > 0 && (
              <section aria-label="Sering dibeli">
                <h3 className="pb-1 text-[0.8125rem] font-semibold uppercase tracking-wide text-ink-500">Sering dibeli</h3>
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

            <section aria-label="Pembelian terakhir">
              <h3 className="pb-1 text-[0.8125rem] font-semibold uppercase tracking-wide text-ink-500">Pembelian terakhir</h3>
              {orders.length === 0 ? (
                <p className="text-[0.8125rem] text-ink-500">{status === 'loading' ? 'Memuat…' : 'Belum ada pembelian tercatat.'}</p>
              ) : (
                orders.map((o) => {
                  const paid = o.lines.filter((l) => !l.free)
                  return (
                    <div key={o.id} className="flex items-center gap-3 border-b border-paper-2 py-2 last:border-0">
                      <div className="min-w-0 flex-1">
                        <p className="text-[0.8125rem] text-ink-500">{dateText(o.at)} · {relativeDays(o.at, now) ?? ''} · <span className="tnum">{formatRupiah(o.total)}</span></p>
                        <p className="truncate text-[0.9375rem] text-ink-900">{itemsText(o.lines) || o.number}</p>
                      </div>
                      <Button variant="secondary" disabled={paid.length === 0} onClick={() => onRepeat(o.lines)} aria-label={`Ulangi ${o.number}`} className="flex-shrink-0">Ulangi</Button>
                    </div>
                  )
                })
              )}
            </section>

            {server && profile.notes.length > 0 && (
              <section aria-label="Catatan">
                <h3 className="pb-1 text-[0.8125rem] font-semibold uppercase tracking-wide text-ink-500">Catatan</h3>
                {profile.notes.map((n, i) => (
                  <p key={`${n.at}-${i}`} className="text-[0.9375rem] text-ink-900"><span className="text-ink-500">{dateText(n.at)} · {n.kind}</span> {n.text}</p>
                ))}
              </section>
            )}

            {!server && status !== 'loading' && <p className="text-[0.8125rem] text-ink-500">Riwayat lengkap butuh internet.</p>}
          </div>
          <div className="flex-shrink-0 border-t border-paper-2 p-3">
            <button
              type="button" onClick={() => (attached ? onClose() : onSelect(customer))}
              className="min-h-14 w-full rounded-control bg-brand px-4 text-[0.9375rem] font-bold uppercase tracking-wide text-on-brand active:bg-brand-pressed"
            >
              {attached ? 'Sudah dipilih · Tutup' : 'Pilih untuk transaksi ini'}
            </button>
          </div>
        </>
      )}
    </Sheet>
  )
}
