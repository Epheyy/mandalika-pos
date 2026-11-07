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

  describe('header (one "‹ Kembali" control, W2-02 / M-12)', () => {
    it('renders a top-left "Kembali" control before the centred title', () => {
      const html = render({ title: 'Judul', onClose: () => {}, header: true, variant: 'side' })
      expect(html).toContain('<h2 id="sheet-title"')
      expect(html).toContain('text-center')
      expect(html).toContain('Judul')
      expect(html.indexOf('Kembali')).toBeGreaterThan(-1)
      expect(html.indexOf('Kembali')).toBeLessThan(html.indexOf('Judul'))
      expect(html).toContain('min-h-11')
    })

    it('names the control by its visible text: no aria-label on it, the chevron is decorative', () => {
      const html = render({ title: 'Judul', onClose: () => {}, header: true, variant: 'side' })
      const button = html.match(/<button type="button" class="press[^>]*>.*?<\/button>/)?.[0] ?? ''
      expect(button).toContain('Kembali')
      expect(button).not.toContain('aria-label')
      expect(button).toContain('<span aria-hidden="true" class="text-xl leading-none">‹</span>')
      // the pointer-only backdrop is hidden from the accessibility tree, so the header button is the only close control there
      expect(html.match(/aria-hidden="true" tabindex="-1"/g)).toHaveLength(1)
      expect(html.match(/aria-label="Tutup"/g)).toHaveLength(1)
    })

    it('honours backLabel on the control and closeLabel only on the backdrop', () => {
      const html = render({ title: 'Judul', onClose: () => {}, header: true, backLabel: 'Pelanggan', closeLabel: 'Tutup panel' })
      expect(html).toContain('</span>Pelanggan</button>')
      expect(html.match(/aria-label="Tutup panel"/g)).toHaveLength(1)
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
      row.props.children[0].props.onClick?.()
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })
})
