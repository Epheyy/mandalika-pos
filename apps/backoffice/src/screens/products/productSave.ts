import type { OutletConfigItemInput, ProductInput, ProductVariant } from '@mandalika/api'
import type { api as backofficeApi } from '../../api'
import { EMPTY_OC, ocKey } from './types'
import type { OcRow, OcfgOutlet } from './types'

type SaveApi = Pick<typeof backofficeApi, 'createProduct' | 'updateProduct' | 'updateProductOutletConfig'>

/** price + available for every (outlet, size) the editor shows; stock/PAR are owned by Inventori. */
export function outletConfigItems(
  outlets: readonly OcfgOutlet[],
  variants: readonly ProductVariant[],
  matrix: Readonly<Record<string, OcRow>>,
): OutletConfigItemInput[] {
  return outlets.flatMap((o) =>
    variants.filter((v) => v.size).map((v) => {
      const c = matrix[ocKey(o.id, v.size)] ?? EMPTY_OC
      return { outletId: o.id, variantSize: v.size, price: c.price, available: c.available }
    }),
  )
}

interface PersistArgs {
  productId: string | null
  /** View-only catalogue: the shared product is never written (the server refuses it); only the covered outlets' config is. */
  catalogueLocked: boolean
  body: ProductInput
  items: OutletConfigItemInput[]
  hasOutlets: boolean
}

/** Shown when a locked editor has no outlet of the user's to save (new product, or the outlet list failed to load). */
export const NOTHING_TO_SAVE = 'Tidak ada outlet Anda yang bisa disimpan untuk produk ini.'

/** The writes one Simpan makes. Locked: outlet config only (an error when there is none, so the editor stays open). Otherwise as before. */
export async function persistProduct(client: SaveApi, { productId, catalogueLocked, body, items, hasOutlets }: PersistArgs): Promise<void> {
  if (catalogueLocked) {
    if (!productId || !hasOutlets) throw new Error(NOTHING_TO_SAVE)
    await client.updateProductOutletConfig(productId, items)
    return
  }
  if (!productId) {
    await client.createProduct(body)
    return
  }
  await client.updateProduct(productId, body)
  if (hasOutlets) await client.updateProductOutletConfig(productId, items)
}
