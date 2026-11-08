// Hoisted once: Intl constructors allocate locale-data tables per call.
const IDR_FORMAT = new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
})

export type BrandId = 'mandalika' | 'flamboyan' | 'performance'
export const DEFAULT_BRAND: BrandId = 'mandalika'

/** Per-skin overrides of the shared semantic tokens (D-27 / D-28), mirroring apps/pos/src/brand. */
export interface BrandOverrides {
  /** Flamboyan purple collides with the promo plum. */
  promo?: string
  /** Info shifts to slate in the same skin. */
  info?: string
  /** Performance red collides with danger; solid danger surfaces use ink-900. */
  dangerSolid?: 'ink'
}

export interface BrandSkin {
  id: BrandId
  name: string
  tagline: string
  logo: string
  logoUrl: string
  /** Brand colour (decorative, large text only: white on Mandalika gold is 3.6:1). */
  primary: string
  primaryPressed: string
  /** Filled-control surface behind white 14 px labels (>= 4.5:1, D-73). */
  primaryStrong: string
  overrides?: BrandOverrides
}

/** Mix a #rrggbb colour towards black by `amount` (0..1). */
export function darken(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16)
  const ch = (shift: number) =>
    Math.round(((n >> shift) & 0xff) * (1 - amount))
      .toString(16)
      .padStart(2, '0')
  return `#${ch(16)}${ch(8)}${ch(0)}`
}

const PRESSED_DARKEN = 0.15

export const BRAND_SKINS: Readonly<Record<BrandId, BrandSkin>> = {
  mandalika: {
    id: 'mandalika',
    name: 'Mandalika',
    tagline: 'Your Scent, Your Statement',
    logo: 'M',
    // tests/browser/serve-app.mjs rewrites this exact literal: keep it verbatim.
    logoUrl:
      'https://mandalikaperfume.co.id/wp-content/uploads/2025/02/GOLD-Tanpa-Text-Bawah.png',
    primary: '#b07d18',
    primaryPressed: '#8f6412',
    primaryStrong: '#8f6412',
  },
  flamboyan: {
    id: 'flamboyan',
    name: 'Flamboyan',
    tagline: '',
    logo: 'F',
    logoUrl: '/brands/flamboyan-logo-240.webp',
    primary: '#9b59b6',
    primaryPressed: darken('#9b59b6', PRESSED_DARKEN),
    primaryStrong: '#9b59b6', // 4.7:1 with white already
    overrides: { promo: '#1d4ed8', info: '#475569' },
  },
  performance: {
    id: 'performance',
    name: 'Performance Perfume',
    tagline: '',
    logo: 'P',
    logoUrl: '/brands/performance-logo-240.webp',
    primary: '#a93226',
    primaryPressed: darken('#a93226', PRESSED_DARKEN),
    primaryStrong: '#a93226', // 6.6:1 with white already
    overrides: { dangerSolid: 'ink' },
  },
}

/** Resolve a VITE_BRAND value; unknown or empty falls back to Mandalika. */
export function resolveBrand(raw: string | undefined): BrandSkin {
  const key = (raw ?? '').trim().toLowerCase()
  return key in BRAND_SKINS ? BRAND_SKINS[key as BrandId] : BRAND_SKINS[DEFAULT_BRAND]
}

const skin = resolveBrand(import.meta.env.VITE_BRAND)

/** What the screens read. The shape (name, logoUrl, colors.primaryHex, currency) is relied on by
 *  App.tsx and the money formatting; keep it stable. */
export const BRAND = {
  id: skin.id,
  name: skin.name,
  tagline: skin.tagline,
  logo: skin.logo,
  logoUrl: skin.logoUrl,

  currency: {
    code: 'IDR',
    symbol: 'Rp',
    locale: 'id-ID',
    format: (amount: number) => IDR_FORMAT.format(amount),
  },

  colors: {
    primaryHex: skin.primary,
    dark: '#1a1008',
  },
}

const TINT = 'color-mix(in srgb, {c} 12%, white)'

// The legacy `gold-*` ramp is pinned to Mandalika gold in index.css; another skin re-derives it
// from its primary so unmigrated screens follow. Mandalika sets nothing (CSS stays as authored).
const GOLD_STEPS: ReadonlyArray<readonly [string, string]> = [
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

/** The CSS custom properties a skin sets on the document element. Pure, so it is unit-tested. */
export function skinVariables(s: BrandSkin): ReadonlyArray<readonly [string, string]> {
  const out: Array<readonly [string, string]> = [
    ['--color-brand', s.primary],
    ['--color-brand-pressed', s.primaryPressed],
    ['--color-brand-strong', s.primaryStrong],
    ['--color-brand-strong-hover', darken(s.primaryStrong, PRESSED_DARKEN)],
  ]
  if (s.id !== 'mandalika') {
    for (const [step, tpl] of GOLD_STEPS) out.push([`--color-gold-${step}`, tpl.replace('{p}', s.primary)])
  }
  const { promo, info, dangerSolid } = s.overrides ?? {}
  if (promo) out.push(['--color-promo', promo], ['--color-promo-bg', TINT.replace('{c}', promo)])
  if (info) out.push(['--color-info', info], ['--color-info-bg', TINT.replace('{c}', info)])
  if (dangerSolid === 'ink') out.push(['--color-danger-solid', 'var(--color-ink-900)'])
  return out
}

/** Set the active skin's custom properties on `root` (the document element at boot). Idempotent. */
export function applyBrandSkin(root: HTMLElement = document.documentElement, s: BrandSkin = skin): void {
  for (const [name, value] of skinVariables(s)) root.style.setProperty(name, value)
}
