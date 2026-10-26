import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { formatRupiah } from '../../cashier/pricing'
import { Money } from './Money'

const render = (props: { amount: number; signed?: boolean }) => renderToStaticMarkup(createElement(Money, props))

describe('Money', () => {
  it('formats like formatRupiah with tabular figures', () => {
    const html = render({ amount: 1251000 })
    expect(html).toContain('tnum')
    expect(html).toContain(formatRupiah(1251000))
  })

  it('prefixes negatives with U+2212 when signed', () => {
    const html = render({ amount: -5000, signed: true })
    expect(html).toContain('\u2212 ')
    expect(html).toContain(formatRupiah(5000))
  })

  it('leaves negatives to the formatter when not signed', () => {
    expect(render({ amount: -5000 })).toContain(formatRupiah(-5000))
  })
})
