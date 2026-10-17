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

  it('still swallows transport failures', async () => {
    request.mockRejectedValue(new Error('offline'))
    await expect(reportErrors([{ source: 'print', message: 'x' }])).resolves.toBeUndefined()
  })
})
