import { describe, expect, it, vi } from 'vitest'
import { UNLOCK_PIN_DONE, UNLOCK_PIN_NOTE, unlockPinErrorMessage, unlockReceivePin } from './unlockPin'

describe('unlockReceivePin', () => {
  it('calls the admin unlock for that user and reports success', async () => {
    const api = { clearUserReceivePinLockout: vi.fn().mockResolvedValue(undefined) }
    expect(await unlockReceivePin(api, 'u1')).toEqual({ ok: true, message: UNLOCK_PIN_DONE })
    expect(api.clearUserReceivePinLockout).toHaveBeenCalledWith('u1')
  })

  it('maps a failure to a user-facing message without echoing server text', async () => {
    const api = { clearUserReceivePinLockout: vi.fn().mockRejectedValue(Object.assign(new Error('SQLSTATE secret'), { status: 404 })) }
    const r = await unlockReceivePin(api, 'u1')
    expect(r.ok).toBe(false)
    expect(r.message).toBe(unlockPinErrorMessage(404))
    expect(r.message).not.toContain('SQLSTATE')
  })

  it('has a fallback message and a note that setting a PIN revokes pending approvals', () => {
    expect(unlockPinErrorMessage(500)).toMatch(/Gagal/)
    expect(unlockPinErrorMessage(403)).toMatch(/tidak dapat/)
    expect(UNLOCK_PIN_NOTE).toMatch(/PIN baru membatalkan/)
  })
})
