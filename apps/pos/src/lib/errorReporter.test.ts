import { beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.fn()
vi.mock('../api', () => ({ api: { request: (...a: unknown[]) => request(...a) } }))

import { track } from './activityLog'
import { reportErrors } from './errorReporter'

beforeEach(() => { request.mockReset().mockResolvedValue({ ok: true }) })

describe('reportErrors redaction (A37)', () => {
  it('sends no pin, phone, email or Bearer token from message, action, payload (any depth) or breadcrumbs', async () => {
    track('pelanggan 081234567890 dipilih')
    const payload = {
      orderId: 'o-1',
      customer: { customerPhone: '081234567890', email: 'budi@example.com' },
      steps: [{ pin: 'CANARY-PIN', header: 'Bearer CANARY.TOKEN.VALUE' }],
    }
    const frozen = JSON.stringify(payload)
    await reportErrors([{
      source: 'sync', kind: 'dead_letter', action: 'GET /x?token=CANARY-URL',
      message: 'gagal untuk 081234567890 (budi@example.com)', payload,
    }])
    expect(request).toHaveBeenCalledTimes(1)
    const sent = JSON.stringify(request.mock.calls[0][2])
    for (const canary of ['CANARY', '081234567890', 'budi@example.com']) expect(sent).not.toContain(canary)
    expect(sent).toContain('o-1') // ids survive
    expect(JSON.stringify(payload)).toBe(frozen) // caller payload untouched
  })

  it('serializes an Error payload with its stack redacted', async () => {
    await reportErrors([{ source: 'runtime', message: 'boom', payload: new Error('failed Bearer CANARY.ABC.DEF') }])
    const sent = JSON.stringify(request.mock.calls[0][2])
    expect(sent).not.toContain('CANARY')
    expect(sent).toContain('failed Bearer [REDACTED]')
  })

  it('sends large report sets in chunks of 10', async () => {
    await reportErrors(Array.from({ length: 25 }, (_, i) => ({ source: 'sync' as const, message: `m${i}` })))
    expect(request.mock.calls.map((c) => (c[2] as { items: unknown[] }).items.length)).toEqual([10, 10, 5])
  })

  it('splits by byte budget as well as item count, never emptying a chunk', async () => {
    const big = 'y'.repeat(1500)
    const payload = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, big]))
    await reportErrors(Array.from({ length: 9 }, (_, i) => ({ source: 'sync' as const, message: `m${i}`, payload })))
    const sizes = request.mock.calls.map((c) => (c[2] as { items: unknown[] }).items.length)
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(9)
    expect(sizes.every((n) => n >= 1)).toBe(true)
    expect(sizes.length).toBeGreaterThan(1)
    for (const c of request.mock.calls) expect(JSON.stringify(c[2]).length).toBeLessThan(260_000)
  })

  it('never rejects when the payload throws while being read', async () => {
    const hostile = new Proxy({}, { ownKeys() { throw new Error('boom') }, get() { throw new Error('boom') } })
    await expect(reportErrors([{ source: 'runtime', message: 'm', payload: hostile }])).resolves.toBeUndefined()
  })

  it('still swallows transport failures', async () => {
    request.mockRejectedValue(new Error('offline'))
    await expect(reportErrors([{ source: 'print', message: 'x' }])).resolves.toBeUndefined()
  })
})
