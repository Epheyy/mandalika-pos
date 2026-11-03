/*
 * The Ikhtisar matrices (Stok Produk and Bahan) as URL state:
 *   #/inventori/stok?q=&jenis=&hal=&per=                      the matrix
 *   #/inventori/stok/lokasi/{outlet|gudang}/<id>              one location's stock
 *   #/inventori/bahan/ikhtisar/lokasi/{outlet|gudang}/<id>    the same for ingredients
 * Pure, tested in node. Defaults (outlets, page 1, 25 rows) stay out of the URL.
 */
import { buildHash } from '../../lib/router/hash'
import { isUuidSegment, segmentAfter } from '../../lib/router/tabs'
import type { ListSchema } from '../../lib/router/useListState'

export type LocationKind = 'outlet' | 'warehouse'

const KIND_SLUG: Readonly<Record<LocationKind, string>> = { outlet: 'outlet', warehouse: 'gudang' }

export interface LocationRef {
  kind: LocationKind
  id: string
}

/** ".../lokasi/<outlet|gudang>/<uuid>" under `base` (+ `offset` extra segments, e.g. the Bahan "ikhtisar" tab), else null. */
export function locationFromPath(path: readonly string[], base: readonly string[], offset = 0): LocationRef | null {
  if (segmentAfter(path, base, offset) !== 'lokasi') return null
  const slug = segmentAfter(path, base, offset + 1)
  const id = segmentAfter(path, base, offset + 2)
  if (id === undefined || !isUuidSegment(id)) return null
  const kind = (Object.keys(KIND_SLUG) as LocationKind[]).find((k) => KIND_SLUG[k] === slug)
  return kind ? { kind, id } : null
}

export function locationHash(prefix: readonly string[], ref: LocationRef): string {
  return buildHash([...prefix, 'lokasi', KIND_SLUG[ref.kind], ref.id])
}

export type KindFilter = LocationKind | 'semua'
export const OVERVIEW_PAGE_SIZES = [25, 50, 100] as const

export interface OverviewQuery extends Record<string, string | number | boolean> {
  q: string
  jenis: string
  hal: number
  per: number
}
export const OVERVIEW_SCHEMA: ListSchema<OverviewQuery> = {
  q: { key: 'q', default: '' },
  jenis: { key: 'jenis', default: 'outlet' },
  hal: { key: 'hal', default: 1 },
  per: { key: 'per', default: 25 },
}

/** URL code of a kind filter: "gudang" in the URL, "warehouse" in the data. */
export function kindFilterOf(raw: string): KindFilter {
  if (raw === 'gudang') return 'warehouse'
  if (raw === 'semua') return 'semua'
  return 'outlet'
}
export const kindFilterCode = (kind: KindFilter): string => (kind === 'warehouse' ? 'gudang' : kind)

export const overviewPageOf = (raw: number): number => (Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1)
export const overviewSizeOf = (raw: number): number =>
  (OVERVIEW_PAGE_SIZES as readonly number[]).includes(raw) ? raw : OVERVIEW_PAGE_SIZES[0]
