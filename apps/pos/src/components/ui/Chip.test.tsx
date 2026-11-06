import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Chip } from './Chip'

describe('Chip', () => {
  it('renders a 44px pill with the label', () => {
    const html = renderToStaticMarkup(createElement(Chip, null, 'Semua'))
    expect(html).toContain('min-h-11')
    expect(html).toContain('rounded-chip')
    expect(html).toContain('Semua')
  })

  it('renders a pressable button with aria-pressed when clickable', () => {
    const html = renderToStaticMarkup(createElement(Chip, { onClick: () => {}, selected: true }, 'Tunai'))
    expect(html).toContain('<button')
    expect(html).toContain('aria-pressed="true"')
  })

  it('uses the tone palette when selected and white otherwise', () => {
    expect(renderToStaticMarkup(createElement(Chip, { selected: true, tone: 'ok' }, 'x'))).toContain('bg-ok-bg text-ok')
    expect(renderToStaticMarkup(createElement(Chip, { tone: 'ok' }, 'x'))).toContain('surface-card')
  })

  it('fills a selected neutral chip with brand-strong (AA with white text)', () => {
    expect(renderToStaticMarkup(createElement(Chip, { selected: true }, 'x'))).toContain('bg-brand-strong text-on-brand')
    expect(renderToStaticMarkup(createElement(Chip, null, 'x'))).toContain('surface-card')
  })

  it('shows a decorative dot when asked', () => {
    expect(renderToStaticMarkup(createElement(Chip, { dot: true }, 'x'))).toContain('aria-hidden="true"')
  })
})
