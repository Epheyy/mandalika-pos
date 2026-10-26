import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Banner } from './Banner'

describe('Banner', () => {
  it('renders the message as an alert with the tone palette', () => {
    const html = renderToStaticMarkup(createElement(Banner, { tone: 'danger', message: 'Terkunci' }))
    expect(html).toContain('role="alert"')
    expect(html).toContain('Terkunci')
    expect(html).toContain('bg-danger-bg')
    expect(html).not.toContain('<button')
  })
  it('renders one action button when given', () => {
    const html = renderToStaticMarkup(createElement(Banner, { tone: 'danger', message: 'x', action: { label: 'Cek koneksi', onClick: vi.fn() } }))
    expect(html).toContain('Cek koneksi')
    expect(html.match(/<button/g)).toHaveLength(1)
  })
})
