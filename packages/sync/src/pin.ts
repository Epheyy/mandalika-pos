import { argon2Verify } from 'hash-wasm'

/** Verify a 4-8 digit PIN against an argon2id PHC string produced by the Go
 *  backend (auth.HashPassword). Returns false on any parse/verify failure. */
export async function verifyPin(pin: string, encodedHash: string): Promise<boolean> {
  if (!pin || !encodedHash) return false
  try {
    return await argon2Verify({ password: pin, hash: encodedHash })
  } catch {
    return false
  }
}
