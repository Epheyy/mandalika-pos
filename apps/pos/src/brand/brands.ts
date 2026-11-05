import mandalikaLogo from '../assets/logo-gold.png'
import flamboyanLogo from '../assets/brands/flamboyan-logo-240.webp'
import performanceLogo from '../assets/brands/performance-logo-240.webp'

export type BrandId = 'mandalika' | 'flamboyan' | 'performance'

/**
 * UI-visible flow switches (build-time). All true today; flipping one for a brand hides the
 * matching menu entry / checkout block without touching the screen. Behaviour that differs per
 * company (pricing, promo types, tax, receipt layout) is NOT here: it lives in backend app-settings
 * per deployment (see docs/runbooks/brand-builds.md).
 */
export type BrandFeatures = {
  loyalty: boolean
  requisitions: boolean
  giveaway: boolean
  customerProfile: boolean
}
export type FeatureName = keyof BrandFeatures

export type BrandOverrides = {
  /** D-27: Flamboyan purple collides with the promo plum. */
  promo?: string
  /** D-27: info shifts to slate in the same skin. */
  info?: string
  /** D-28: Performance red collides with danger; solid danger surfaces use ink-900. */
  dangerSolid?: 'ink'
}

export type Brand = {
  id: BrandId
  displayName: string
  primary: string
  primaryPressed: string
  /** Filled-control surface behind white 14 px labels (>= 4.5:1, D-73). Brands whose primary already passes AA use it. */
  primaryStrong: string
  logo: string
  tagline?: string
  /** Fallback receipt header; the backend app-settings value wins once the snapshot is loaded. */
  receiptHeader: string
  overrides?: BrandOverrides
  features: BrandFeatures
}

const ALL_FEATURES: BrandFeatures = { loyalty: true, requisitions: true, giveaway: true, customerProfile: true }

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

export const BRANDS: Readonly<Record<BrandId, Brand>> = {
  mandalika: {
    id: 'mandalika',
    displayName: 'Mandalika',
    primary: '#b07d18',
    primaryPressed: '#8f6412',
    primaryStrong: '#8f6412',
    logo: mandalikaLogo,
    tagline: 'Your Trusted Scent',
    receiptHeader: 'Mandalika Perfume',
    features: { ...ALL_FEATURES },
  },
  flamboyan: {
    id: 'flamboyan',
    displayName: 'Flamboyan',
    primary: '#9b59b6',
    primaryPressed: darken('#9b59b6', PRESSED_DARKEN),
    primaryStrong: '#9b59b6',
    logo: flamboyanLogo,
    receiptHeader: 'Flamboyan',
    overrides: { promo: '#1d4ed8', info: '#475569' },
    features: { ...ALL_FEATURES },
  },
  performance: {
    id: 'performance',
    displayName: 'Performance Perfume',
    primary: '#a93226',
    primaryPressed: darken('#a93226', PRESSED_DARKEN),
    primaryStrong: '#a93226',
    logo: performanceLogo,
    receiptHeader: 'Performance Perfume',
    overrides: { dangerSolid: 'ink' },
    features: { ...ALL_FEATURES },
  },
}
