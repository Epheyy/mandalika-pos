import { darken, type Brand } from './brands'

const STRONG_HOVER_DARKEN = 0.15

const TINT = 'color-mix(in srgb, {c} 12%, white)'

/** Set the brand's custom properties on `root` (the document element at boot). Idempotent. */
export function applyBrand(brand: Brand, root: HTMLElement = document.documentElement): void {
  const set = (name: string, value: string) => root.style.setProperty(name, value)
  set('--color-brand', brand.primary)
  set('--color-brand-pressed', brand.primaryPressed)
  set('--color-brand-strong', brand.primaryStrong)
  set('--color-brand-strong-hover', darken(brand.primaryStrong, STRONG_HOVER_DARKEN))
  const { promo, info, dangerSolid } = brand.overrides ?? {}
  if (promo) {
    set('--color-promo', promo)
    set('--color-promo-bg', TINT.replace('{c}', promo))
  }
  if (info) {
    set('--color-info', info)
    set('--color-info-bg', TINT.replace('{c}', info))
  }
  if (dangerSolid === 'ink') set('--color-danger-solid', 'var(--color-ink-900)')
}
