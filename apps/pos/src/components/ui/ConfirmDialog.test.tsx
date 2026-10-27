import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react', async (orig) => ({ ...(await orig<typeof import('react')>()), useId: () => 'sheet-title' }))

import { ConfirmDialog } from './ConfirmDialog'

const noop = () => {}
const base = { message: 'Kosongkan keranjang? Pelanggan, promo dan catatan ikut terhapus.', confirmLabel: 'Kosongkan', onConfirm: noop, onCancel: noop }

describe('ConfirmDialog', () => {
  it('renders nothing when closed', () => {
    expect(renderToStaticMarkup(createElement(ConfirmDialog, { ...base, open: false }))).toBe('')
  })

  it('renders the message with Batal and the confirm label, above other sheets (z-70)', () => {
    const out = renderToStaticMarkup(createElement(ConfirmDialog, { ...base, open: true, tone: 'danger' }))
    expect(out).toContain('Kosongkan keranjang? Pelanggan, promo dan catatan ikut terhapus.')
    expect(out).toContain('Batal')
    expect(out).toContain('>Kosongkan<')
    expect(out).toContain('z-[70]')
    expect(out).toContain('bg-danger')
  })

  it('wires Batal and the confirm button to their handlers', () => {
    const onCancel = vi.fn(), onConfirm = vi.fn()
    const tree = ConfirmDialog({ ...base, open: true, onCancel, onConfirm }) as ReactElement<{ children: ReactElement<{ children: unknown[] }>[] }>
    const buttons = (tree.props.children as unknown as ReactElement<{ children: ReactElement<{ onClick: () => void; children: string }>[] }>[])[1].props.children
    buttons.find((b) => b.props.children === 'Batal')?.props.onClick()
    buttons.find((b) => b.props.children === 'Kosongkan')?.props.onClick()
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
