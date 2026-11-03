import { buildHash } from '../../lib/router/hash'
import type { ListSchema } from '../../lib/router/useListState'
import { MOVEMENT_KINDS, type MovementKind } from './stockCardFormat'

/** The Kartu Stok route, under the Stok Produk tab. */
export const KARTU_STOK_PATH = ['inventori', 'stok', 'kartu-stok'] as const

/**
 * Kartu Stok state in the query: `#/inventori/stok/kartu-stok?sku=&lokasi=&dari=&sampai=&jenis=`.
 * `lokasi` is `outlet:<id>` or `warehouse:<id>`, `sku` is `<productId>|<variantSize>`, `dari`/`sampai` are
 * YYYY-MM-DD, `jenis` is a comma list of ledger kinds plus the flags `hadiah` and `minus`. Empty means the
 * screen default (first location, last 30 days, every kind), so a default never appears in the URL.
 */
export const KARTU_SCHEMA: ListSchema<{ lokasi: string; sku: string; dari: string; sampai: string; jenis: string }> = {
  lokasi: { key: 'lokasi', default: '' },
  sku: { key: 'sku', default: '' },
  dari: { key: 'dari', default: '' },
  sampai: { key: 'sampai', default: '' },
  jenis: { key: 'jenis', default: '' },
}

export interface SkuRef {
  productId: string
  variantSize: string
}

/** `<productId>|<variantSize>`; a product id never holds a bar, a variant size may hold anything. */
export function encodeSku(s: SkuRef): string {
  return `${s.productId}|${s.variantSize}`
}

export function decodeSku(raw: string): SkuRef | null {
  const cut = raw.indexOf('|')
  if (cut <= 0 || cut === raw.length - 1) return null
  return { productId: raw.slice(0, cut), variantSize: raw.slice(cut + 1) }
}

export interface JenisFilter {
  kinds: readonly MovementKind[]
  giveaway: boolean
  shortage: boolean
}

/** Unknown entries are dropped, so an old or hand-edited link never filters on a kind the API would refuse. */
export function parseJenis(raw: string): JenisFilter {
  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean)
  return {
    kinds: MOVEMENT_KINDS.filter((k) => parts.includes(k)),
    giveaway: parts.includes('hadiah'),
    shortage: parts.includes('minus'),
  }
}

export function serializeJenis(f: JenisFilter): string {
  return [
    ...MOVEMENT_KINDS.filter((k) => f.kinds.includes(k)),
    ...(f.giveaway ? ['hadiah'] : []),
    ...(f.shortage ? ['minus'] : []),
  ].join(',')
}

/**
 * Replaces what one chip group holds. `groupIds` are the ids that group can hold (kinds, or `hadiah` / `minus`),
 * `selected` is its new selection; every other group's choice is kept.
 */
export function withGroupSelection(current: JenisFilter, groupIds: readonly string[], selected: readonly string[]): JenisFilter {
  const kept = serializeJenis(current).split(',').filter((t) => t !== '' && !groupIds.includes(t))
  return parseJenis([...kept, ...selected.filter((id) => groupIds.includes(id))].join(','))
}

export interface KartuStokLink {
  sku: SkuRef
  locationKey: string
  fromDay: string
  toDay: string
  /** Shown until the first ledger row names the SKU. */
  label?: string
}

const labels = new Map<string, string>()

/** The name of a SKU the user just picked, for a card opened by a link built here (the URL carries no name). */
export function rememberSkuLabel(sku: SkuRef, label: string): void {
  labels.set(encodeSku(sku), label)
}

export function rememberedSkuLabel(sku: SkuRef): string | undefined {
  return labels.get(encodeSku(sku))
}

/** The hash a Pergerakan row opens: its SKU, location and range. */
export function kartuStokHash(link: KartuStokLink): string {
  if (link.label) rememberSkuLabel(link.sku, link.label)
  return buildHash(KARTU_STOK_PATH, {
    sku: encodeSku(link.sku),
    lokasi: link.locationKey,
    dari: link.fromDay,
    sampai: link.toDay,
  })
}
