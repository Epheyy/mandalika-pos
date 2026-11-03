import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, createClient } from '@mandalika/api'
import { BATCH_AMBIGUOUS_HINT, BATCH_KEY_CONFLICT_MESSAGE, batchWriteError, createBatchKeyHolder } from './batchWrite'
import { EMPTY_BATCH } from './discountCodeForm'

afterEach(() => vi.unstubAllGlobals())

describe('createDiscountCodeBatch sends the Idempotency-Key', () => {
  it('puts the key in the Idempotency-Key header of POST /discount-codes/batch', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const api = createClient({ baseUrl: 'http://x', getToken: () => 't', onUnauthorized: () => {} })
    await api.createDiscountCodeBatch(EMPTY_BATCH, 'key-1')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/discount-codes/batch')
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe('key-1')
  })
})

describe('createBatchKeyHolder: one key per form open', () => {
  it('returns the same key on every retry from one open', () => {
    let n = 0
    const holder = createBatchKeyHolder(() => `k${++n}`)
    expect(holder.current()).toBe('k1')
    expect(holder.current()).toBe('k1')
  })
  it('mints a new key after the form closes (drop) and so on a reopen', () => {
    let n = 0
    const holder = createBatchKeyHolder(() => `k${++n}`)
    const first = holder.current()
    holder.drop()
    expect(holder.current()).not.toBe(first)
  })
})

describe('batchWriteError', () => {
  it('reads a key conflict as already recorded, with no retry advice', () => {
    const msg = batchWriteError(new ApiError(409, 'kunci idempotensi sudah dipakai untuk operasi lain'), 'x')
    expect(msg).toBe(BATCH_KEY_CONFLICT_MESSAGE)
    expect(msg).toMatch(/^Sudah tercatat/)
    expect(msg).not.toMatch(/Generate lagi/)
  })
  it('tells the user to press Generate again for status 0 and 5xx', () => {
    expect(batchWriteError(new ApiError(0, 'Jaringan terputus', 'network'), 'x')).toBe(`Jaringan terputus.${BATCH_AMBIGUOUS_HINT}`)
    expect(batchWriteError(new ApiError(503, 'Layanan tidak tersedia.'), 'x')).toBe(`Layanan tidak tersedia.${BATCH_AMBIGUOUS_HINT}`)
  })
  it('keeps the plain server text for a definite refusal and falls back for a non-Error', () => {
    expect(batchWriteError(new ApiError(422, 'Prefix terlalu panjang'), 'x')).toBe('Prefix terlalu panjang')
    expect(batchWriteError(new ApiError(409, 'stok terkunci'), 'x')).toBe('stok terkunci')
    expect(batchWriteError('boom', 'Kode massal gagal dibuat.')).toBe('Kode massal gagal dibuat.')
  })
})
