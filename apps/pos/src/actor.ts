import type { ActorContext } from '@mandalika/sync'
import { authStore } from './api'

/** Capture-time identity for the sync engine (A04): read at the instant an operation is
 *  committed to the outbox. Null (no signed-in account, or no terminal outlet yet) makes
 *  the engine refuse the operation instead of storing it under an unknown identity. */
export function currentActor(): ActorContext | null {
  const { outletId, userId, shiftId } = authStore
  if (!outletId || !userId) return null
  return { outletId, userId, shiftId }
}
