import { describe, expect, it } from 'vitest'
import { confirmLeave, registerNavGuard } from './navGuard'

describe('navGuard', () => {
  it('lets navigation through when no guard is registered', async () => {
    expect(await confirmLeave()).toBe(true)
  })

  it('awaits the registered guard and returns its answer', async () => {
    const off = registerNavGuard(async () => false)
    expect(await confirmLeave()).toBe(false)
    off()
    expect(await confirmLeave()).toBe(true)
  })

  it('an old unregister does not clear a newer guard', async () => {
    const offOld = registerNavGuard(async () => true)
    const offNew = registerNavGuard(async () => false)
    offOld()
    expect(await confirmLeave()).toBe(false)
    offNew()
  })
})
