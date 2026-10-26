import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// Sheet is called as a plain function in the click test (no DOM in this workspace),
// so give it a hook-free useId.
vi.mock('react', async (orig) => ({ ...(await orig<typeof import('react')>()), useId: () => 'sheet-title' }))

import { Sheet } from './Sheet'

const render = (props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(Sheet, { open: true, variant: 'center', ...props }, createElement('p', null, 'isi')))

describe('Sheet', () => {
  it('renders nothing when closed', () => {
    expect(render({ open: false })).toBe('')
  })

  it('renders a labelled dialog with the title in an h2', () => {
    const html = render({ title: 'Judul' })
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('<h2 id="sheet-title"')
    expect(html).toContain('aria-labelledby="sheet-title"')
    expect(html).toContain('Judul')
    expect(html).toContain('isi')
  })

  it('renders the existing centred modal recipe with z-index and width', () => {
    const html = render({ z: 70, maxWidth: 'max-w-sm', panelClassName: 'p-5' })
    expect(html).toContain('fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-[70]')
    expect(html).toContain('bg-white rounded-2xl w-full shadow-xl max-w-sm p-5')
  })

  it('adds no backdrop button when onClose is not given', () => {
    expect(render({})).not.toContain('<button')
  })

  it('renders a backdrop button with the close label that calls onClose', () => {
    const onClose = vi.fn()
    const tree = Sheet({ open: true, variant: 'side', onClose, closeLabel: 'Tutup panel' }) as ReactElement<{ children: ReactElement[] }>
    const backdrop = tree.props.children[0] as ReactElement<{ onClick: () => void; 'aria-label': string }>
    expect(backdrop.type).toBe('button')
    expect(backdrop.props['aria-label']).toBe('Tutup panel')
    backdrop.props.onClick()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('lays out the side variant against the right edge', () => {
    const html = render({ variant: 'side', onClose: () => {} })
    expect(html).toContain('fixed inset-0 flex justify-end z-50')
    expect(html).toContain('max-w-lg')
    expect(html).toContain('aria-label="Tutup"')
  })
})
