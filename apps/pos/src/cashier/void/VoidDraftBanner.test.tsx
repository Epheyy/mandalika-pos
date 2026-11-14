import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Banner } from '../../components/ui/Banner'
import { cashierReducer, CASHIER_INITIAL_STATE } from '../state/cashierReducer'
import { VoidDraftBanner } from './VoidDraftBanner'
import type { VoidDraft } from './voidReplacement'

const draft = (over: Partial<VoidDraft> = {}): VoidDraft => ({
  orderId: 'o1', orderNumber: 'BSD-7', originalTotal: 100000, originalTenders: [], reason: 'salah_barang', note: '', stockChoices: {},
  shiftId: 's1', amountsLocked: false, kind: 'void_and_replace', ...over,
})
const html = (d: VoidDraft) => renderToStaticMarkup(createElement(VoidDraftBanner, { draft: d, choice: 'adjust', onChoice: vi.fn(), onCancel: vi.fn() }))

function find(node: unknown, pred: (el: ReactElement) => boolean): ReactElement | undefined {
  if (Array.isArray(node)) { for (const n of node) { const r = find(n, pred); if (r) return r } return undefined }
  if (!node || typeof node !== 'object' || !('props' in node)) return undefined
  const el = node as ReactElement<{ children?: unknown }>
  return pred(el) ? el : find(el.props.children, pred)
}

describe('VoidDraftBanner', () => {
  it('says the void waits for its replacement and offers Batalkan pengganti', () => {
    const out = html(draft())
    expect(out).toContain('Pembatalan transaksi #BSD-7 menunggu pengganti')
    expect(out).toContain('Batalkan pengganti')
  })

  it('Batalkan pengganti drops the draft and clears the cart: nothing is voided', () => {
    const onCancel = vi.fn()
    const tree = VoidDraftBanner({ draft: draft(), choice: 'adjust', onChoice: vi.fn(), onCancel })
    const banner = find(tree, (el) => el.type === Banner) as ReactElement<{ action: { onClick: () => void } }>
    banner.props.action.onClick()
    expect(onCancel).toHaveBeenCalledOnce()
    const started = cashierReducer(
      { ...CASHIER_INITIAL_STATE, cart: [{ productId: 'p', productName: 'P', variantSize: '50ml', price: 1, quantity: 1, subtotal: 1 }] as never },
      { type: 'VOID_DRAFT_START', draft: draft() },
    )
    expect(started.voidDraft).not.toBeNull()
    const cancelled = cashierReducer(started, { type: 'VOID_DRAFT_CANCEL' })
    expect(cancelled.voidDraft).toBeNull()
    expect(cancelled.cart).toEqual([])
  })

  it('shows the correction choice only when the amounts are not locked', () => {
    expect(html(draft())).toContain('Catat sebagai Penyesuaian koreksi')
    expect(html(draft())).toContain('Pelanggan bayar/terima selisih')
    expect(html(draft({ amountsLocked: true }))).not.toContain('Penyesuaian koreksi')
    const rep = html(draft({ kind: 'create_replacement' }))
    expect(rep).toContain('Pengganti untuk transaksi #BSD-7')
    expect(rep).not.toContain('Penyesuaian koreksi')
  })

  it('the choice chips dispatch SET_VOID_CORRECTION_CHOICE values', () => {
    const onChoice = vi.fn()
    const tree = VoidDraftBanner({ draft: draft(), choice: 'adjust', onChoice, onCancel: vi.fn() })
    const settle = find(tree, (el) => (el.props as { children?: unknown }).children === 'Pelanggan bayar/terima selisih') as ReactElement<{ onClick: () => void }>
    settle.props.onClick()
    expect(onChoice).toHaveBeenCalledWith('settle')
    const s = cashierReducer({ ...CASHIER_INITIAL_STATE, voidDraft: draft() }, { type: 'SET_VOID_CORRECTION_CHOICE', choice: 'settle' })
    expect(s.voidCorrectionChoice).toBe('settle')
  })
})
