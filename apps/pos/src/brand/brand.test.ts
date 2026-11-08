import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyBrand } from './apply'
import { BRANDS, darken, type BrandId } from './brands'
import { resolveBrand } from './index'

/** WCAG 2.x relative luminance contrast of a #rrggbb colour against white. */
function contrastWithWhite(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const lin = (c: number) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  const l = 0.2126 * lin((n >> 16) & 0xff) + 0.7152 * lin((n >> 8) & 0xff) + 0.0722 * lin(n & 0xff)
  return 1.05 / (l + 0.05)
}

function fakeRoot() {
  const props = new Map<string, string>()
  const root = { style: { setProperty: (k: string, v: string) => void props.set(k, v) } } as unknown as HTMLElement
  return { root, props }
}

afterEach(() => vi.restoreAllMocks())

describe('resolveBrand', () => {
  it('defaults to mandalika when unset or empty, without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveBrand(undefined).id).toBe('mandalika')
    expect(resolveBrand('').id).toBe('mandalika')
    expect(warn).not.toHaveBeenCalled()
  })

  it('falls back to mandalika with exactly one warning for an unknown id', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveBrand('acme').id).toBe('mandalika')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('does not resolve inherited object keys such as "constructor"', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveBrand('constructor').id).toBe('mandalika')
  })

  it.each<[BrandId, string]>([
    ['mandalika', '#b07d18'],
    ['flamboyan', '#9b59b6'],
    ['performance', '#a93226'],
  ])('resolves %s with its primary colour', (id, primary) => {
    const b = resolveBrand(id)
    expect(b.id).toBe(id)
    expect(b.primary).toBe(primary)
    expect(b.logo).toBeTruthy()
    expect(b.receiptHeader).toBeTruthy()
  })
})

describe('registry contents', () => {
  it('carries the D-27 overrides on Flamboyan only', () => {
    expect(BRANDS.flamboyan.overrides).toEqual({ promo: '#1d4ed8', info: '#475569' })
    expect(BRANDS.mandalika.overrides).toBeUndefined()
  })

  it('carries the D-28 override on Performance only', () => {
    expect(BRANDS.performance.overrides).toEqual({ dangerSolid: 'ink' })
  })

  it('enables every feature for every brand (scaffold only)', () => {
    for (const b of Object.values(BRANDS)) {
      expect(b.features).toEqual({ loyalty: true, requisitions: true, giveaway: true, customerProfile: true })
    }
  })

  it('does not share one features object between brands', () => {
    expect(BRANDS.flamboyan.features).not.toBe(BRANDS.mandalika.features)
  })
})

describe('darken', () => {
  it('scales each channel by 1 - amount', () => {
    expect(darken('#ffffff', 0.15)).toBe('#d9d9d9')
    expect(darken('#000000', 0.15)).toBe('#000000')
    expect(darken('#a93226', 0.15)).toBe('#902b20')
  })

  it('derives the pressed colour of the non-Mandalika brands at 15 % darker', () => {
    expect(BRANDS.flamboyan.primaryPressed).toBe(darken('#9b59b6', 0.15))
    expect(BRANDS.performance.primaryPressed).toBe(darken('#a93226', 0.15))
  })
})

describe('applyBrand', () => {
  it('sets only brand colours for mandalika', () => {
    const { root, props } = fakeRoot()
    applyBrand(BRANDS.mandalika, root)
    expect([...props.keys()].sort()).toEqual([
      '--color-brand',
      '--color-brand-pressed',
      '--color-brand-strong',
      '--color-brand-strong-hover',
    ])
    expect(props.get('--color-brand')).toBe('#b07d18')
    expect(props.get('--color-brand-pressed')).toBe('#8f6412')
  })

  it('sets promo/info for flamboyan', () => {
    const { root, props } = fakeRoot()
    applyBrand(BRANDS.flamboyan, root)
    expect(props.get('--color-brand')).toBe('#9b59b6')
    expect(props.get('--color-promo')).toBe('#1d4ed8')
    expect(props.get('--color-promo-bg')).toContain('color-mix')
    expect(props.get('--color-info')).toBe('#475569')
    expect(props.get('--color-info-bg')).toContain('#475569')
    expect(props.has('--color-danger-solid')).toBe(false)
  })

  it('maps the solid danger token to ink-900 for performance and leaves promo/info alone', () => {
    const { root, props } = fakeRoot()
    applyBrand(BRANDS.performance, root)
    expect(props.get('--color-brand')).toBe('#a93226')
    expect(props.get('--color-danger-solid')).toBe('var(--color-ink-900)')
    expect(props.has('--color-promo')).toBe(false)
    expect(props.has('--color-info')).toBe(false)
  })
})

describe('brand-strong (filled controls behind white 14 px labels, D-73)', () => {
  it.each<[BrandId, string]>([
    ['mandalika', '#8f6412'],
    ['flamboyan', '#9b59b6'],
    ['performance', '#a93226'],
  ])('%s carries its strong colour and passes AA with white text', (id, strong) => {
    expect(BRANDS[id].primaryStrong).toBe(strong)
    expect(contrastWithWhite(BRANDS[id].primaryStrong)).toBeGreaterThanOrEqual(4.5)
  })

  it('Mandalika gold itself fails AA with white (why the strong colour exists); the other skins use their brand colour', () => {
    expect(contrastWithWhite(BRANDS.mandalika.primary)).toBeLessThan(4.5)
    expect(BRANDS.flamboyan.primaryStrong).toBe(BRANDS.flamboyan.primary)
    expect(BRANDS.performance.primaryStrong).toBe(BRANDS.performance.primary)
  })

  it.each<BrandId>(['mandalika', 'flamboyan', 'performance'])('applyBrand sets strong + hover for %s', (id) => {
    const { root, props } = fakeRoot()
    applyBrand(BRANDS[id], root)
    expect(props.get('--color-brand-strong')).toBe(BRANDS[id].primaryStrong)
    expect(props.get('--color-brand-strong-hover')).toBe(darken(BRANDS[id].primaryStrong, 0.15))
  })

  it('Mandalika strong + hover equal the shared token defaults, so the skin is a no-op for it', () => {
    const { root, props } = fakeRoot()
    applyBrand(BRANDS.mandalika, root)
    const tokens = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/ui-tokens/tokens.css'),
      'utf8',
    )
    expect(tokens).toContain(`--color-brand-strong: ${props.get('--color-brand-strong')};`)
    expect(tokens).toContain(`--color-brand-strong-hover: ${props.get('--color-brand-strong-hover')};`)
  })
})
