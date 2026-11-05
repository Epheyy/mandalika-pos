import { darken, type Brand } from './brands'

const STRONG_HOVER_DARKEN = 0.15

const TINT = 'color-mix(in srgb, {c} 12%, white)'

/**
 * The Tailwind `indigo-*` scale is the app's legacy brand scale (160 usages across 18 files);
 * index.css pins it to Mandalika gold. A different brand re-derives it from its primary so those
 * utilities follow the skin too. Mandalika sets nothing, so its CSS stays byte-identical.
 */
const INDIGO_STEPS: ReadonlyArray<readonly [string, string]> = [
  ['50', 'color-mix(in srgb, {p} 8%, white)'],
  ['100', 'color-mix(in srgb, {p} 20%, white)'],
  ['200', 'color-mix(in srgb, {p} 42%, white)'],
  ['300', 'color-mix(in srgb, {p} 65%, white)'],
  ['400', 'color-mix(in srgb, {p} 84%, white)'],
  ['500', 'color-mix(in srgb, {p} 92%, white)'],
  ['600', '{p}'],
  ['700', 'color-mix(in srgb, {p} 82%, black)'],
  ['800', 'color-mix(in srgb, {p} 64%, black)'],
  ['900', 'color-mix(in srgb, {p} 45%, black)'],
]

/** Set the brand's custom properties on `root` (the document element at boot). Idempotent. */
export function applyBrand(brand: Brand, root: HTMLElement = document.documentElement): void {
  const set = (name: string, value: string) => root.style.setProperty(name, value)
  set('--color-brand', brand.primary)
  set('--color-brand-pressed', brand.primaryPressed)
  set('--color-brand-strong', brand.primaryStrong)
  set('--color-brand-strong-hover', darken(brand.primaryStrong, STRONG_HOVER_DARKEN))
  if (brand.id !== 'mandalika') {
    for (const [step, tpl] of INDIGO_STEPS) set(`--color-indigo-${step}`, tpl.replace('{p}', brand.primary))
  }
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
