import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BRAND_SKINS, applyBrandSkin, resolveBrand, skinVariables, type BrandId } from './brand'

const css = readFileSync(new URL('../../../../packages/ui-tokens/tokens.css', import.meta.url), 'utf8')

function token(name: string): string {
  const m = css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`))
  if (!m) throw new Error(`token --color-${name} is not a plain hex in tokens.css`)
  return m[1]
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [16, 8, 0].map((s) => {
    const c = ((n >> s) & 0xff) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const AA = 4.5
const WHITE = '#ffffff'

describe('contrast table (plan 2.1, WCAG 2.x)', () => {
  const pass: Array<[string, string, string, number?]> = [
    ['white on brand-strong (filled controls)', WHITE, token('brand-strong'), 5.25],
    ['white on brand-strong-hover', WHITE, token('brand-strong-hover')],
    ['warn-strong on warn-bg (badge text)', token('warn-strong'), token('warn-bg'), 5.3],
    ['ink-700 on paper-1 (table headers)', token('ink-700'), token('paper-1'), 8.9],
    ['ink-500 on paper-0', token('ink-500'), token('paper-0'), 4.65],
    ['ink-500 on white', token('ink-500'), WHITE, 4.9],
    ['ok on ok-bg', token('ok'), token('ok-bg')],
    ['danger on danger-bg', token('danger'), token('danger-bg')],
    ['info on info-bg', token('info'), token('info-bg')],
    ['promo on promo-bg', token('promo'), token('promo-bg')],
    ['reward on reward-bg', token('reward'), token('reward-bg')],
    ['white on danger', WHITE, token('danger')],
  ]
  it.each(pass)('%s meets AA', (_name, fg, bg, approx) => {
    const ratio = contrast(fg, bg)
    expect(ratio).toBeGreaterThanOrEqual(AA)
    if (approx) expect(ratio).toBeCloseTo(approx, 1)
  })

  it('documents why brand needs a strong variant: white on gold brand fails AA', () => {
    expect(contrast(WHITE, token('brand'))).toBeLessThan(AA)
    expect(contrast(WHITE, token('brand'))).toBeCloseTo(3.6, 1)
  })

  it('documents why ink-500 is not for paper-1 and warn is not for badges', () => {
    expect(contrast(token('ink-500'), token('paper-1'))).toBeLessThan(AA)
    expect(contrast(token('warn'), token('warn-bg'))).toBeLessThan(AA)
  })

  it.each(Object.keys(BRAND_SKINS) as BrandId[])('white on the %s skin filled-control colour meets AA', (id) => {
    expect(contrast(WHITE, BRAND_SKINS[id].primaryStrong)).toBeGreaterThanOrEqual(AA)
  })

  it('the Flamboyan info override (slate) on its tint meets AA', () => {
    expect(contrast('#475569', '#e3eafc')).toBeGreaterThanOrEqual(AA)
  })
})

describe('brand registry', () => {
  it('falls back to Mandalika for unknown or empty values', () => {
    expect(resolveBrand(undefined).id).toBe('mandalika')
    expect(resolveBrand('').id).toBe('mandalika')
    expect(resolveBrand('nope').id).toBe('mandalika')
    expect(resolveBrand(' Flamboyan ').id).toBe('flamboyan')
  })

  it('keeps the Mandalika logo literal that tests/browser/serve-app.mjs rewrites', () => {
    const src = readFileSync(new URL('./brand.ts', import.meta.url), 'utf8')
    expect(src).toContain('https://mandalikaperfume.co.id/wp-content/uploads/2025/02/GOLD-Tanpa-Text-Bawah.png')
  })

  it('Mandalika sets only the brand variables; other skins also re-derive gold and apply overrides', () => {
    const names = (id: BrandId) => skinVariables(BRAND_SKINS[id]).map(([n]) => n)
    expect(names('mandalika')).toEqual([
      '--color-brand',
      '--color-brand-pressed',
      '--color-brand-strong',
      '--color-brand-strong-hover',
    ])
    expect(names('flamboyan')).toContain('--color-gold-600')
    expect(names('flamboyan')).toContain('--color-promo')
    expect(names('flamboyan')).toContain('--color-info')
    expect(skinVariables(BRAND_SKINS.performance)).toContainEqual(['--color-danger-solid', 'var(--color-ink-900)'])
  })

  it('applyBrandSkin writes the variables onto the given element', () => {
    const set: Record<string, string> = {}
    const root = { style: { setProperty: (k: string, v: string) => (set[k] = v) } } as unknown as HTMLElement
    applyBrandSkin(root, BRAND_SKINS.performance)
    expect(set['--color-brand']).toBe('#a93226')
    expect(set['--color-brand-strong']).toBe('#a93226')
  })

  it('the tokens file declares the brand-strong pair and warn-strong', () => {
    for (const t of ['brand-strong', 'brand-strong-hover', 'warn-strong']) expect(css).toContain(`--color-${t}:`)
  })
})
