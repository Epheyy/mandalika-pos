import type { ReceiptLine } from '@mandalika/printer'
import { variantLabel } from '@mandalika/types'
import { bundleLabel, type BundleRole } from './setBundles'

/** The minimal shape every receipt caller can supply: a cart line, a snapshot line or a server order item. */
export interface BundleLineSource {
  name: string
  variantSize: string
  /** What the line was paid after its own pricing (a bundle piece: its share of the bundle net). */
  amount: number
  bundleGroup?: number
  bundleRole?: BundleRole
  bundleLine?: string
  bundleSize?: string
  bundleDiscount?: number
  bundlePromotionId?: string
}

type BundleFields = Pick<BundleLineSource, 'bundleGroup' | 'bundleRole' | 'bundleLine' | 'bundleSize' | 'bundleDiscount' | 'bundlePromotionId'>
const pickBundle = (l: { bundleGroup?: number; bundleRole?: string; bundleLine?: string; bundleSize?: string; bundleDiscount?: number; bundlePromotionId?: string }): BundleFields => ({
  bundleGroup: l.bundleGroup,
  bundleRole: l.bundleRole as BundleRole | undefined,
  bundleLine: l.bundleLine,
  bundleSize: l.bundleSize,
  bundleDiscount: l.bundleDiscount,
  bundlePromotionId: l.bundlePromotionId,
})

/** A receipt-snapshot line (`name`, `amount`) as a source. */
export function fromSnapshotLine(l: { name: string; variantSize: string; amount: number } & BundleFields): BundleLineSource {
  return { name: l.name, variantSize: l.variantSize, amount: l.amount, ...pickBundle(l) }
}

/** A cart line or server order item (`productName`, `subtotal`) as a source. */
export function fromOrderItem(i: { productName: string; variantSize: string; subtotal: number; bundleGroup?: number; bundleRole?: string; bundleLine?: string; bundleSize?: string; bundleDiscount?: number; bundlePromotionId?: string }): BundleLineSource {
  return { name: i.productName, variantSize: i.variantSize, amount: i.subtotal, ...pickBundle(i) }
}

export interface CollapsedBundle {
  kind: 'bundle'
  group: number
  name: string
  pieces: string[]
  /** The bundle price before any Diskon Bundle. */
  price: number
  discount: number
  discountLabel?: string
  /** Σ the pieces' net amounts (what the bundle cost the customer). */
  amount: number
}

const ROLE_ORDER: Record<string, number> = { large: 0, atomizer: 1, vial: 2 }

/** One entry per bundle group (at its large piece's position), every other line unchanged and in order.
 *  A group with no `large` piece, or a line with a `bundleGroup` and no role, stays as plain lines. */
export function collapseBundleLines<T extends BundleLineSource>(
  lines: T[],
  promotionName: (id: string) => string | undefined,
): Array<{ kind: 'single'; line: T } | CollapsedBundle> {
  const groups = new Map<number, T[]>()
  for (const l of lines) {
    if (l.bundleGroup != null && l.bundleRole) groups.set(l.bundleGroup, [...(groups.get(l.bundleGroup) ?? []), l])
  }
  const out: Array<{ kind: 'single'; line: T } | CollapsedBundle> = []
  const done = new Set<number>()
  for (const l of lines) {
    const g = l.bundleGroup
    const members = g != null ? groups.get(g) : undefined
    if (g == null || !members || !members.some((m) => m.bundleRole === 'large')) {
      out.push({ kind: 'single', line: l })
      continue
    }
    if (done.has(g)) continue
    if (l.bundleRole !== 'large') {
      // a piece listed before its large bottle: the bundle still sits at the large piece's position
      continue
    }
    done.add(g)
    const sorted = [...members].sort((a, b) => (ROLE_ORDER[a.bundleRole ?? ''] ?? 9) - (ROLE_ORDER[b.bundleRole ?? ''] ?? 9))
    const amount = members.reduce((n, m) => n + m.amount, 0)
    const discount = members.reduce((n, m) => n + (m.bundleDiscount ?? 0), 0)
    const promoId = members.find((m) => m.bundlePromotionId)?.bundlePromotionId
    out.push({
      kind: 'bundle',
      group: g,
      name: `${l.name} · ${bundleLabel(l.bundleLine ?? '', l.bundleSize ?? '')}`,
      pieces: sorted.map((m) => `${m.name} ${variantLabel(m.variantSize)}`.trim()),
      price: amount + discount,
      discount,
      ...(discount > 0 ? { discountLabel: (promoId ? promotionName(promoId) : undefined) ?? 'Diskon Bundle' } : {}),
      amount,
    })
  }
  return out
}

/** The printable line of a collapsed bundle. `amount` is the net, so `receiptAddsUp` still holds; the gross price and
 *  the Diskon Bundle row print around it. */
export function bundleReceiptLine(b: CollapsedBundle): ReceiptLine {
  return {
    name: b.name,
    qty: 1,
    unitPrice: b.price,
    amount: b.amount,
    pieces: b.pieces,
    ...(b.discount > 0 ? { lineDiscount: { label: b.discountLabel ?? 'Diskon Bundle', amount: b.discount } } : {}),
  }
}
