import type { ProductVariant } from '@mandalika/api'

export const EMPTY_VARIANT: ProductVariant = { size: '', price: 0, stock: 0, sku: '', barcode: '' } // stock kept at 0; UI no longer shows it (managed in Inventori)
export const MAX_IMAGES = 5

export type Form = {
  name: string; brand: string; categoryId: string; description: string
  images: string[]; sellable: boolean
  isActive: boolean; isFeatured: boolean; variants: ProductVariant[]
}

export const EMPTY: Form = {
  name: '', brand: 'Mandalika', categoryId: '', description: '', images: [],
  sellable: true, isActive: true, isFeatured: false,
  variants: [{ ...EMPTY_VARIANT }],
}

// Per-outlet editable row for one (outlet, variant): null price = use base.
// Stock + PAR are managed in the Inventori module; only price + availability here.
export type OcRow = { price: number | null; available: boolean }
export const EMPTY_OC: OcRow = { price: null, available: true }

export const ocKey = (oid: string, size: string) => `${oid}|${size}`

export type OcfgOutlet = { id: string; name: string }
