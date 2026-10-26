import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Button } from './Button'

const render = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(Button, props, 'Bayar'))

describe('Button', () => {
  it('renders the primary md recipe by default with type=button', () => {
    const html = render()
    expect(html).toContain('bg-brand text-on-brand')
    expect(html).toContain('min-h-12')
    expect(html).toContain('type="button"')
    expect(html).toContain('Bayar')
  })

  it('uses the 64px height for size lg', () => {
    expect(render({ size: 'lg' })).toContain('min-h-16')
  })

  it.each([
    ['secondary', 'border-paper-2'],
    ['ghost', 'text-ink-700'],
    ['danger', 'bg-danger'],
    ['promo', 'bg-promo-bg text-promo'],
    ['reward', 'bg-reward-bg text-reward'],
  ])('applies the %s variant', (variant, expected) => {
    expect(render({ variant })).toContain(expected)
  })

  it('disables the button and marks it busy while loading', () => {
    const html = render({ loading: true })
    expect(html).toContain('disabled')
    expect(html).toContain('aria-busy="true"')
  })

  it('stretches to full width when requested', () => {
    expect(render({ fullWidth: true })).toContain('w-full')
  })
})
