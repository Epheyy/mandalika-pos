import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '@mandalika/api'
import {
  OFFLINE_MESSAGE,
  REFUSED_MESSAGE,
  formatCountdown,
  requestReceiveGrant,
} from './receiveApprovalFlow'

const input = {
  idempotencyKey: 'dev:u1',
  transferId: 't1',
  items: [{ productId: 'p1', variantSize: 'M', receivedQty: 3 }],
  discrepancyReason: '',
  approverUserId: 'a1',
  pin: '4321',
}

const online = () => true

describe('requestReceiveGrant', () => {
  it('is offline-blocked without calling the server', async () => {
    const request = vi.fn()
    expect(await requestReceiveGrant({ isOnline: () => false, request }, input)).toEqual({ kind: 'offline', message: OFFLINE_MESSAGE })
    expect(request).not.toHaveBeenCalled()
    expect(OFFLINE_MESSAGE).toBe('Persetujuan penerimaan butuh koneksi internet.')
  })

  it('returns the grant on success', async () => {
    const request = vi.fn().mockResolvedValue({ approvalGrantId: 'g1' })
    expect(await requestReceiveGrant({ isOnline: online, request }, input)).toEqual({ kind: 'granted', grantId: 'g1' })
    expect(request).toHaveBeenCalledWith(input)
  })

  it('maps the uniform 403 to the single refusal text', async () => {
    const request = vi.fn().mockRejectedValue(new ApiError(403, REFUSED_MESSAGE, 'http'))
    expect(await requestReceiveGrant({ isOnline: online, request }, input)).toEqual({ kind: 'refused', message: REFUSED_MESSAGE })
  })

  it('keeps another 403 (transfer not for this outlet) as its own message', async () => {
    const request = vi.fn().mockRejectedValue(new ApiError(403, 'transfer bukan untuk outlet ini', 'http'))
    expect(await requestReceiveGrant({ isOnline: online, request }, input)).toEqual({ kind: 'failed', message: 'transfer bukan untuk outlet ini' })
  })

  it('maps 429 to a countdown from retryAfterSeconds', async () => {
    const request = vi.fn().mockRejectedValue(new ApiError(429, 'Terkunci', 'http', { error: 'Terkunci', retryAfterSeconds: 90, hardLocked: false }))
    expect(await requestReceiveGrant({ isOnline: online, request }, input)).toEqual({ kind: 'locked', retryAfterSeconds: 90, hard: false, message: 'Terkunci' })
  })

  it('maps a hard lock (no countdown)', async () => {
    const request = vi.fn().mockRejectedValue(new ApiError(429, 'Terkunci, hubungi admin', 'http', { error: 'Terkunci, hubungi admin', retryAfterSeconds: 0, hardLocked: true }))
    const r = await requestReceiveGrant({ isOnline: online, request }, input)
    expect(r).toMatchObject({ kind: 'locked', hard: true })
  })

  it('treats a 429 without a usable body as a short generic lock', async () => {
    const request = vi.fn().mockRejectedValue(new ApiError(429, 'x', 'http'))
    expect(await requestReceiveGrant({ isOnline: online, request }, input)).toMatchObject({ kind: 'locked', retryAfterSeconds: 60 })
  })

  it.each([
    [new ApiError(0, 'x', 'network')],
    [new ApiError(0, 'x', 'timeout')],
    [new ApiError(503, 'x', 'http')],
  ])('a transport or server failure is retryable and never a refusal (%#)', async (err) => {
    const request = vi.fn().mockRejectedValue(err)
    const r = await requestReceiveGrant({ isOnline: online, request }, input)
    expect(r.kind).toBe('failed')
  })

  it('an old server (404) says it needs a newer server', async () => {
    const request = vi.fn().mockRejectedValue(new ApiError(404, 'not found', 'http'))
    const r = await requestReceiveGrant({ isOnline: online, request }, input)
    expect(r.kind).toBe('failed')
    expect((r as { message: string }).message).toContain('internet')
  })
})

describe('formatCountdown', () => {
  it('formats m:ss', () => {
    expect(formatCountdown(0)).toBe('0:00')
    expect(formatCountdown(65)).toBe('1:05')
    expect(formatCountdown(900)).toBe('15:00')
    expect(formatCountdown(-3)).toBe('0:00')
  })
})
