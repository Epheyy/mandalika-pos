import { BRANDS, type Brand, type BrandId, type FeatureName } from './brands'

export { applyBrand } from './apply'
export { BRANDS, darken } from './brands'
export type { Brand, BrandId, FeatureName } from './brands'

const DEFAULT_BRAND: BrandId = 'mandalika'

/** Resolve a VITE_BRAND value; unknown or empty falls back to Mandalika (warns once when set but unknown). */
export function resolveBrand(raw: string | undefined): Brand {
  if (!raw) return BRANDS[DEFAULT_BRAND]
  if (Object.prototype.hasOwnProperty.call(BRANDS, raw)) return BRANDS[raw as BrandId]
  console.warn(`[brand] Unknown VITE_BRAND "${raw}", falling back to "${DEFAULT_BRAND}"`)
  return BRANDS[DEFAULT_BRAND]
}

export const brand: Brand = resolveBrand(import.meta.env.VITE_BRAND)

export function hasFeature(name: FeatureName): boolean {
  return brand.features[name]
}
