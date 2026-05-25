import { describe, it, expect } from 'vitest'
import { verifyPin } from './pin'

// Fixture produced by backend auth.HashPassword("1234") — proves Go↔JS argon2id compat.
const GO_HASH = '$argon2id$v=19$m=65536,t=1,p=4$zVkhzeKmqjt9dbouFTESNw$Lo6EYI6unIsRpjECG0W7wPYiUDD064648TweqLGthK4'

describe('verifyPin (Go↔JS argon2id)', () => {
  it('accepts the correct PIN against a backend-generated hash', async () => {
    expect(await verifyPin('1234', GO_HASH)).toBe(true)
  })
  it('rejects a wrong PIN', async () => {
    expect(await verifyPin('9999', GO_HASH)).toBe(false)
  })
  it('rejects empty inputs', async () => {
    expect(await verifyPin('', GO_HASH)).toBe(false)
    expect(await verifyPin('1234', '')).toBe(false)
  })
})
