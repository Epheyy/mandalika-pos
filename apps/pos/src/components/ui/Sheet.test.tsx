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
    expect(html).toContain('fixed inset-0 bg-ink-900/40 flex items-center justify-center p-4 z-[70]')
    expect(html).toContain('surface-solid rounded-panel w-full max-w-sm p-5')
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

  it('keeps the legacy layout (no header, no extra close) unless header is requested', () => {
    const html = render({ title: 'Judul', onClose: () => {} })
    expect(html).not.toContain('border-b border-paper-2')
    expect(html.match(/aria-label="Tutup"/g)).toHaveLength(1) // the backdrop only
  })

  describe('header (one close control, M-12)', () => {
    it('renders the title and a single top-right close control named "Tutup"', () => {
      const html = render({ title: 'Judul', onClose: () => {}, header: true, variant: 'side' })
      expect(html).toContain('<h2 id="sheet-title"')
      expect(html).toContain('Judul')
      expect(html).toContain('h-11 w-11')
      // the backdrop is hidden from the accessibility tree, so the header button is the only "Tutup" there
      expect(html.match(/aria-label="Tutup"/g)).toHaveLength(2)
      expect(html.match(/aria-hidden="true" tabindex="-1"/g)).toHaveLength(1)
    })

    it('honours a custom closeLabel on the control', () => {
      const html = render({ title: 'Judul', onClose: () => {}, header: true, closeLabel: 'Tutup panel' })
      expect(html.match(/aria-label="Tutup panel"/g)).toHaveLength(2)
    })

    it('renders no header without onClose or on the full variant', () => {
      expect(render({ title: 'Judul', header: true })).not.toContain('border-b border-paper-2')
      expect(render({ title: 'Judul', header: true, onClose: () => {}, variant: 'full' })).not.toContain('border-b border-paper-2')
    })

    it('wires the header close control to onClose', () => {
      const onClose = vi.fn()
      const tree = Sheet({ open: true, variant: 'center', onClose, header: true, title: 'Judul' }) as ReactElement<{ children: ReactElement[] }>
      const panel = tree.props.children[1] as ReactElement<{ children: ReactElement<{ children: ReactElement<{ onClick?: () => void }>[] }>[] }>
      const row = panel.props.children[0] as ReactElement<{ children: ReactElement<{ onClick?: () => void }>[] }>
      row.props.children[1].props.onClick?.()
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })
})
