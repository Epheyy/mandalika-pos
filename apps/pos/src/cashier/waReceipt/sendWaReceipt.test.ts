import { describe, expect, it, vi } from 'vitest'
import { ApiError, type ReceiptLink } from '@mandalika/api'
import { WA_NOT_SYNCED, WA_OFFLINE, WA_PHONE_BAD, WA_PHONE_REQUIRED, createWaLink, openWhatsApp, waBlockReason, waErrorMessage } from './sendWaReceipt'

const LINK: ReceiptLink = { url: 'https://x/r/t', message: 'Halo', waUrl: 'https://wa.me/628123456789?text=Halo', expiresAt: '2026-12-04T00:00:00Z', phoneMasked: '****6789' }
const base = { isOnline: true, phone: '0812 3456 789', allowEmptyPhone: false }

describe('waBlockReason', () => {
  it('blocks offline first', () => expect(waBlockReason({ ...base, isOnline: false })).toBe(WA_OFFLINE))
  it('requires a phone unless the order has a customer', () => {
    expect(waBlockReason({ ...base, phone: ' ' })).toBe(WA_PHONE_REQUIRED)
    expect(waBlockReason({ ...base, phone: '', allowEmptyPhone: true })).toBeNull()
  })
  it('rejects a number the server would reject', () => expect(waBlockReason({ ...base, phone: '123' })).toBe(WA_PHONE_BAD))
  it('accepts a good local number', () => expect(waBlockReason(base)).toBeNull())
})

describe('createWaLink', () => {
  it('offline: sends nothing', async () => {
    const api = { createReceiptLink: vi.fn() }
    const r = await createWaLink(api, { orderUuid: 'u1' }, { ...base, isOnline: false })
    expect(r).toEqual({ ok: false, error: WA_OFFLINE, notSynced: false })
    expect(api.createReceiptLink).not.toHaveBeenCalled()
  })
  it('bad phone: sends nothing', async () => {
    const api = { createReceiptLink: vi.fn() }
    expect((await createWaLink(api, { orderUuid: 'u1' }, { ...base, phone: 'abc' })).ok).toBe(false)
    expect(api.createReceiptLink).not.toHaveBeenCalled()
  })
  it('passes target, phone and deviceId', async () => {
    const api = { createReceiptLink: vi.fn().mockResolvedValue(LINK) }
    const r = await createWaLink(api, { orderUuid: 'u1' }, { ...base, deviceId: 'dev-1' })
    expect(r).toEqual({ ok: true, link: LINK })
    expect(api.createReceiptLink).toHaveBeenCalledWith({ orderUuid: 'u1', phone: '0812 3456 789', deviceId: 'dev-1' })
  })
  it('empty phone is omitted so the server uses the customer number', async () => {
    const api = { createReceiptLink: vi.fn().mockResolvedValue(LINK) }
    await createWaLink(api, { orderId: 'o1' }, { isOnline: true, phone: '', allowEmptyPhone: true })
    expect(api.createReceiptLink).toHaveBeenCalledWith({ orderId: 'o1' })
  })
  it('409 maps to the not-synced copy and flags it', async () => {
    const api = { createReceiptLink: vi.fn().mockRejectedValue(new ApiError(409, 'Order belum tersinkron')) }
    expect(await createWaLink(api, { orderUuid: 'u1' }, base)).toEqual({ ok: false, error: WA_NOT_SYNCED, notSynced: true })
  })
  it('any other 409 shows the server message and is not retryable', async () => {
    const msg = 'Struk digital hanya untuk pesanan yang selesai.'
    const api = { createReceiptLink: vi.fn().mockRejectedValue(new ApiError(409, msg)) }
    expect(await createWaLink(api, { orderId: 'o1' }, base)).toEqual({ ok: false, error: msg, notSynced: false })
  })
})

describe('waErrorMessage', () => {
  it('429 uses Retry-After', () => expect(waErrorMessage(new ApiError(429, 'x', 'http', undefined, 12000))).toBe('Terlalu banyak permintaan. Coba lagi dalam 12 detik.'))
  it('429 without Retry-After', () => expect(waErrorMessage(new ApiError(429, 'x'))).toContain('Coba lagi nanti'))
  it('400 keeps the server text', () => expect(waErrorMessage(new ApiError(400, 'Nomor tidak valid'))).toBe('Nomor tidak valid'))
  it('network failure reads as offline', () => expect(waErrorMessage(new ApiError(0, 'fail', 'network'))).toBe(WA_OFFLINE))
})

describe('openWhatsApp', () => {
  it('opens the wa.me url with the _system target', () => {
    const open = vi.fn()
    openWhatsApp(LINK, open)
    expect(open).toHaveBeenCalledWith(LINK.waUrl, '_system')
  })
})
