import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Sheet, type SheetVariant } from './Sheet'

describe('Sheet keyboard inset', () => {
  it.each<SheetVariant>(['center', 'side', 'full'])('%s container ends above the keyboard', (variant) => {
    const html = renderToStaticMarkup(createElement(Sheet, { open: true, variant, ariaLabel: 'x' }, 'body'))
    expect(html).toMatch(/^<div class="fixed inset-0[^"]*" style="bottom:var\(--kb, ?0px\)"/)
  })
})
