import { afterEach, describe, expect, it, vi } from 'vitest'
import { confirmLeave, hasLeaveGuard, pushLeaveGuard } from './navGuard'

describe('navGuard', () => {
  it('lets navigation through when no guard is registered', async () => {
    expect(hasLeaveGuard()).toBe(false)
    expect(await confirmLeave()).toBe(true)
  })

  it('awaits the registered guard and returns its answer', async () => {
    const off = pushLeaveGuard(async () => false)
    expect(hasLeaveGuard()).toBe(true)
    expect(await confirmLeave()).toBe(false)
    off()
    expect(hasLeaveGuard()).toBe(false)
    expect(await confirmLeave()).toBe(true)
  })

  it('asks only the top guard, and the one below once the top is gone', async () => {
    const low = vi.fn(async () => false)
    const high = vi.fn(async () => true)
    const offLow = pushLeaveGuard(low)
    const offHigh = pushLeaveGuard(high)
    expect(await confirmLeave()).toBe(true)
    expect(high).toHaveBeenCalledTimes(1)
    expect(low).not.toHaveBeenCalled()
    offHigh()
    expect(await confirmLeave()).toBe(false)
    expect(low).toHaveBeenCalledTimes(1)
    offLow()
  })

  it('an old unregister does not clear a newer guard', async () => {
    const offOld = pushLeaveGuard(async () => true)
    const offNew = pushLeaveGuard(async () => false)
    offOld()
    expect(await confirmLeave()).toBe(false)
    offNew()
    expect(hasLeaveGuard()).toBe(false)
  })

  it('unregistering twice is harmless', () => {
    const off = pushLeaveGuard(async () => true)
    off()
    off()
    expect(hasLeaveGuard()).toBe(false)
  })
})

describe('navGuard open question', () => {
  it('asking again while a question is open returns the same answer and asks the guard once', async () => {
    let answer!: (leave: boolean) => void
    const ask = vi.fn(() => new Promise<boolean>((resolve) => { answer = resolve }))
    const off = pushLeaveGuard(ask)
    const first = confirmLeave()
    const second = confirmLeave()
    expect(ask).toHaveBeenCalledTimes(1)
    answer(true)
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    off()
  })

  it('a new question can be asked once the first is answered', async () => {
    const ask = vi.fn(async () => false)
    const off = pushLeaveGuard(ask)
    await confirmLeave()
    await confirmLeave()
    expect(ask).toHaveBeenCalledTimes(2)
    off()
  })

  it('a guard removed while its question is open settles it as stay, and the next question works', async () => {
    const off = pushLeaveGuard(() => new Promise<boolean>(() => {})) // never answered
    const pending = confirmLeave()
    off()
    expect(await pending).toBe(false)
    expect(hasLeaveGuard()).toBe(false)
    expect(await confirmLeave()).toBe(true)
  })

  it('removing a different guard leaves the open question alone', async () => {
    let answer!: (leave: boolean) => void
    const offLow = pushLeaveGuard(async () => false)
    const offTop = pushLeaveGuard(() => new Promise<boolean>((resolve) => { answer = resolve }))
    const pending = confirmLeave()
    offLow()
    answer(true)
    expect(await pending).toBe(true)
    offTop()
  })
})

describe('navGuard beforeunload', () => {
  const stubWindow = () => {
    const add = vi.fn()
    const remove = vi.fn()
    vi.stubGlobal('window', { addEventListener: add, removeEventListener: remove })
    return { add, remove }
  }
  afterEach(() => vi.unstubAllGlobals())

  it('registers the browser warning only while a guard is active, once for a stack', () => {
    const { add, remove } = stubWindow()
    const offA = pushLeaveGuard(async () => true)
    const offB = pushLeaveGuard(async () => true)
    expect(add).toHaveBeenCalledTimes(1)
    expect(add.mock.calls[0][0]).toBe('beforeunload')
    offB()
    expect(remove).not.toHaveBeenCalled()
    offA()
    expect(remove).toHaveBeenCalledTimes(1)
    expect(remove.mock.calls[0]).toEqual(['beforeunload', add.mock.calls[0][1]])
  })

  it('the handler asks the browser to confirm leaving', () => {
    const { add } = stubWindow()
    const off = pushLeaveGuard(async () => true)
    const handler = add.mock.calls[0][1] as (e: BeforeUnloadEvent) => void
    const event = { preventDefault: vi.fn(), returnValue: undefined as unknown }
    handler(event as unknown as BeforeUnloadEvent)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(event.returnValue).toBe('')
    off()
  })
})
