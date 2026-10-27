import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyBrand } from './apply'
import { BRANDS, darken, type BrandId } from './brands'
import { resolveBrand } from './index'

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
  it('sets only brand colours for mandalika (indigo scale stays the css default)', () => {
    const { root, props } = fakeRoot()
    applyBrand(BRANDS.mandalika, root)
    expect([...props.keys()].sort()).toEqual(['--color-brand', '--color-brand-pressed'])
    expect(props.get('--color-brand')).toBe('#b07d18')
    expect(props.get('--color-brand-pressed')).toBe('#8f6412')
  })

  it('sets promo/info and re-derives the indigo scale for flamboyan', () => {
    const { root, props } = fakeRoot()
    applyBrand(BRANDS.flamboyan, root)
    expect(props.get('--color-brand')).toBe('#9b59b6')
    expect(props.get('--color-promo')).toBe('#1d4ed8')
    expect(props.get('--color-promo-bg')).toContain('color-mix')
    expect(props.get('--color-info')).toBe('#475569')
    expect(props.get('--color-info-bg')).toContain('#475569')
    expect(props.get('--color-indigo-600')).toBe('#9b59b6')
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
