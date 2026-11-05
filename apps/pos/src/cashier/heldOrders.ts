import type { components } from '@mandalika/api'
import { getKV, readJSON, writeJSON, type KV } from '@mandalika/sync'
import type { BxgyRewardPick } from './BxgyRewardModal'
import { restoreAllBundles } from './promotionEffects'
import type { CashierState } from './state/cashierReducer'

type CartItem = components['schemas']['CartItem']
type Customer = components['schemas']['Customer']

// D-6 "Pesanan tersimpan": carts parked on THIS tablet (Preferences on native, localStorage on the web shell).
// Never part of the outbox or any payload: a held order is a draft, not a sale. Pure rules + a small store.

export const HELD_ORDERS_MAX = 20
/** Like the tablet customer memory (A30), a held order that holds a customer is forgotten after 30 days. */
export const HELD_ORDERS_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const HELD_ORDERS_FULL_MESSAGE = `Sudah ada ${HELD_ORDERS_MAX} pesanan tersimpan. Hapus atau lanjutkan salah satu dulu.`

/** Just enough of a customer to attach them again (A30: no email, notes or spend history is kept). */
export type HeldCustomer = Pick<Customer, 'id' | 'name' | 'phone' | 'points'> & { segment?: Customer['segment'] }

export interface HeldAdjustment {
  value: number
  type: 'percentage' | 'fixed'
}

export interface HeldOrder {
  v: 1
  id: string
  name: string
  heldAt: number
  /** PAID lines only, with every applied bundle's moved units put back (stock conservation). */
  lines: CartItem[]
  customer: HeldCustomer | null
  salesman: { id: string; name: string } | null
  notes: string
  discount: HeldAdjustment
  surcharge: HeldAdjustment
  stagedDiscountType: 'percentage' | 'fixed'
  promotions: { id: string; name: string }[]
  codes: string[]
  /** The giveaway picks (one per unit) of each separate-set BXGY promotion, keyed by promotion id. */
  rewardPicks: Record<string, BxgyRewardPick[]>
  /** Points and loyalty reward lines are customer- and online-dependent: not kept, the cashier picks them again. */
  loyaltyDropped: boolean
  /**
   * Auto promos the cashier removed for this sale (promo auto-apply). OPTIONAL and unversioned on purpose: an older
   * held order or draft without it restores as before, and a rollback bundle ignores it. Auto-installed promos are
   * never stored (`promotions` is manual only): they are recomputed after a restore.
   */
  dismissedAutoPromotionIds?: string[]
}

const isHeldOrder = (v: unknown): v is HeldOrder => {
  if (!v || typeof v !== 'object') return false
  const o = v as Partial<HeldOrder>
  return (
    o.v === 1 && typeof o.id === 'string' && typeof o.name === 'string' && typeof o.heldAt === 'number' &&
    Array.isArray(o.lines) && Array.isArray(o.promotions) && Array.isArray(o.codes) &&
    !!o.discount && !!o.surcharge && typeof o.rewardPicks === 'object' && o.rewardPicks !== null &&
    (o.dismissedAutoPromotionIds === undefined || Array.isArray(o.dismissedAutoPromotionIds))
  )
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : `${n}`)

/** The name a held order gets when the cashier types none: the customer's name, else "Pesanan HH:MM". */
export function defaultHeldName(customerName: string | null | undefined, now: Date): string {
  const name = customerName?.trim()
  return name ? name : `Pesanan ${pad2(now.getHours())}:${pad2(now.getMinutes())}`
}

export type HeldSource = Pick<
  CashierState,
  | 'cart' | 'selectedCustomer' | 'selectedSalesman' | 'pointsToRedeem' | 'orderNotes' | 'discountRunning' | 'surchargeRunning'
  | 'appliedDiscountType' | 'appliedSurchargeType' | 'discountType' | 'appliedPromotions' | 'appliedPromoCodes' | 'bundleFreed'
> &
  // Optional so a source without the promo auto-apply fields (older callers, tests) is still a HeldSource.
  Partial<Pick<CashierState, 'autoPromotionIds' | 'dismissedAutoPromotionIds'>>

/** Snapshot of the draft sale. Pure: reads the state, returns a new object. Throws nothing; an empty cart is the caller's gate. */
export function heldOrderFromState(state: HeldSource, opts: { id: string; name: string; now: number }): HeldOrder {
  const lines = restoreAllBundles(state.cart, state.bundleFreed).filter((c) => !c.isReward)
  const rewardPicks: Record<string, BxgyRewardPick[]> = {}
  const auto = state.autoPromotionIds ?? []
  const dismissed = state.dismissedAutoPromotionIds ?? []
  for (const c of state.cart) {
    if (!c.isReward || !c.rewardPromotionId || c.rewardPromotionId in state.bundleFreed || auto.includes(c.rewardPromotionId)) continue
    const pick: BxgyRewardPick = { productId: c.productId, productName: c.productName, variantSize: c.variantSize, net: c.price }
    rewardPicks[c.rewardPromotionId] = [...(rewardPicks[c.rewardPromotionId] ?? []), ...Array.from({ length: c.quantity }, () => pick)]
  }
  const c = state.selectedCustomer
  return {
    v: 1,
    id: opts.id,
    name: opts.name,
    heldAt: opts.now,
    lines,
    customer: c ? { id: c.id, name: c.name, phone: c.phone, points: c.points, ...(c.segment ? { segment: c.segment } : {}) } : null,
    salesman: state.selectedSalesman,
    notes: state.orderNotes,
    discount: { value: state.discountRunning, type: state.appliedDiscountType },
    surcharge: { value: state.surchargeRunning, type: state.appliedSurchargeType },
    stagedDiscountType: state.discountType,
    promotions: state.appliedPromotions.filter((p) => !auto.includes(p.id)).map((p) => ({ id: p.id, name: p.name })),
    codes: state.appliedPromoCodes.map((p) => p.code),
    rewardPicks,
    loyaltyDropped: state.pointsToRedeem > 0 || state.cart.some((i) => i.isReward && !!i.rewardConditionId),
    ...(dismissed.length > 0 ? { dismissedAutoPromotionIds: [...dismissed] } : {}),
  }
}

/** The customer record SET_CUSTOMER needs, rebuilt from the kept fields (the rest is never read by the sale). */
export function heldCustomerRecord(c: HeldCustomer, heldAt: number): Customer {
  return { ...c, totalSpent: 0, visitCount: 0, createdAt: new Date(heldAt).toISOString() } as Customer
}

export const heldOrdersKey = (outletId: string): string => `mandalika.pos.heldOrders.${outletId || 'unbound'}`

export const HELD_ORDERS_WRITE_MESSAGE = 'Pesanan tidak bisa disimpan di tablet ini. Keranjang tidak diubah.'

export type SaveResult = { ok: true } | { ok: false; reason: 'full' | 'write' }

/** Held orders on one tablet and outlet, newest first. The key holds the whole list; malformed or expired entries are dropped on read. */
export class HeldOrdersStore {
  constructor(
    private kv: KV,
    private key: string,
    private now: () => number = Date.now,
  ) {}

  list(): HeldOrder[] {
    const raw = readJSON<unknown>(this.kv, this.key, [])
    if (!Array.isArray(raw)) return []
    const cutoff = this.now() - HELD_ORDERS_TTL_MS
    return raw.filter(isHeldOrder).filter((o) => o.heldAt >= cutoff).sort((a, b) => b.heldAt - a.heldAt)
  }

  count(): number {
    return this.list().length
  }

  /** Adds at the front. At the cap nothing is evicted (a parked customer's cart is never lost silently): the save is refused. */
  save(order: HeldOrder): SaveResult {
    const current = this.list()
    if (current.length >= HELD_ORDERS_MAX) return { ok: false, reason: 'full' }
    writeJSON(this.kv, this.key, [order, ...current.filter((o) => o.id !== order.id)])
    // A full or blocked store swallows the write: only report success once the order reads back.
    return this.list().some((o) => o.id === order.id) ? { ok: true } : { ok: false, reason: 'write' }
  }

  remove(id: string): void {
    writeJSON(this.kv, this.key, this.list().filter((o) => o.id !== id))
  }
}

const stores = new Map<string, HeldOrdersStore>()
/** The held-order store for this outlet, on the same KV the engine uses. */
export function getHeldOrders(outletId: string): HeldOrdersStore {
  const key = heldOrdersKey(outletId)
  let s = stores.get(key)
  if (!s) {
    s = new HeldOrdersStore(getKV(), key)
    stores.set(key, s)
  }
  return s
}
