import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ReceiveApprovalModal } from './ReceiveApprovalModal'

const base = {
  receiptKey: 'dev:u1',
  transferId: 't1',
  items: [{ productId: 'p1', variantSize: 'M', receivedQty: 3 }],
  reason: '',
  listApprovers: vi.fn(),
  requestApproval: vi.fn(),
  onCancel: vi.fn(),
  onApproved: vi.fn(),
}

describe('ReceiveApprovalModal', () => {
  it('blocks cleanly offline: message, no PIN field, nothing requested or queued', () => {
    const html = renderToStaticMarkup(createElement(ReceiveApprovalModal, { ...base, isOnline: () => false }))
    expect(html).toContain('Persetujuan penerimaan butuh koneksi internet.')
    expect(html).not.toContain('type="password"')
    expect(base.listApprovers).not.toHaveBeenCalled()
    expect(base.requestApproval).not.toHaveBeenCalled()
    expect(base.onApproved).not.toHaveBeenCalled()
  })
})
