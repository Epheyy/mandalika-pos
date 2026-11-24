import { afterEach, describe, expect, it, vi } from 'vitest'
import { confirmLeave, guardCovers, hasLeaveGuard, pushLeaveGuard } from './navGuard'

describe('scoped guards', () => {
  it('does not ask for a move that stays under the guard scope', async () => {
    const ask = vi.fn(async () => false)
    const off = pushLeaveGuard(ask, { scope: ['pengaturan'] })
    expect(guardCovers(['pengaturan', 'transaksi'])).toBe(false)
    expect(await confirmLeave(['pengaturan', 'operasional'])).toBe(true)
    expect(ask).not.toHaveBeenCalled()
    off()
  })

  it('asks for a move out of the scope, and for a move with no destination', async () => {
    const ask = vi.fn(async () => false)
    const off = pushLeaveGuard(ask, { scope: ['pengaturan'] })
    expect(guardCovers(['laporan'])).toBe(true)
    expect(await confirmLeave(['laporan'])).toBe(false)
    expect(await confirmLeave()).toBe(false) // signing out
    expect(ask).toHaveBeenCalledTimes(2)
    off()
  })

  it('an unscoped guard asks for every move', async () => {
    const off = pushLeaveGuard(async () => false)
    expect(guardCovers(['pengaturan', 'transaksi'])).toBe(true)
    expect(await confirmLeave(['pengaturan', 'transaksi'])).toBe(false)
    off()
  })

  it('a move under the screen scope asks only the overlay guard, not the scoped one below', async () => {
    const offScreen = pushLeaveGuard(async () => true, { scope: ['pengaturan'] })
    const offOverlay = pushLeaveGuard(async () => false)
    expect(await confirmLeave(['pengaturan', 'transaksi'])).toBe(false)
    offOverlay()
    expect(await confirmLeave(['pengaturan', 'transaksi'])).toBe(true)
    offScreen()
  })
})

describe('stacked scoped guards (Settings + receipt designer)', () => {
  const push = (answer: boolean, scope: string[], calls: string[], name: string) =>
    pushLeaveGuard(async () => { calls.push(name); return answer }, { scope })

  it('a guard removed right after answering leave does not settle the next question as stay', async () => {
    // Settings "Simpan & lanjut": the save clears the draft, so its guard goes away just after it answered.
    // The lower guard answers later, like a dialog the admin clicks.
    const lower = vi.fn(() => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 0)))
    const offLower = pushLeaveGuard(lower, { scope: ['pengaturan'] })
    let offUpper = () => {}
    const upper = () => {
      const answer = Promise.resolve(true)
      void answer.then(() => offUpper())
      return answer
    }
    offUpper = pushLeaveGuard(upper, { scope: ['pengaturan', 'struk'] })
    expect(await confirmLeave(['produk'])).toBe(true)
    expect(lower).toHaveBeenCalledTimes(1)
    offLower()
  })

  it('leaving to another screen asks both, top-down', async () => {
    const calls: string[] = []
    const offA = push(true, ['pengaturan'], calls, 'settings')
    const offB = push(true, ['pengaturan', 'struk'], calls, 'struk')
    expect(await confirmLeave(['produk'])).toBe(true)
    expect(calls).toEqual(['struk', 'settings'])
    offB(); offA()
  })

  it('a stay on the top guard never asks the lower one', async () => {
    const calls: string[] = []
    const offA = push(true, ['pengaturan'], calls, 'settings')
    const offB = push(false, ['pengaturan', 'struk'], calls, 'struk')
    expect(await confirmLeave(['produk'])).toBe(false)
    expect(calls).toEqual(['struk'])
    offB(); offA()
  })

  it('a stay on the lower guard returns false after the top left', async () => {
    const calls: string[] = []
    const offA = push(false, ['pengaturan'], calls, 'settings')
    const offB = push(true, ['pengaturan', 'struk'], calls, 'struk')
    expect(await confirmLeave(['produk'])).toBe(false)
    expect(calls).toEqual(['struk', 'settings'])
    offB(); offA()
  })

  it('signing out (no target) asks both', async () => {
    const calls: string[] = []
    const offA = push(true, ['pengaturan'], calls, 'settings')
    const offB = push(true, ['pengaturan', 'struk'], calls, 'struk')
    expect(await confirmLeave()).toBe(true)
    expect(calls).toEqual(['struk', 'settings'])
    offB(); offA()
  })

  it('a move to a tab inside pengaturan asks only the guard that does not cover it', async () => {
    const calls: string[] = []
    const offA = push(true, ['pengaturan'], calls, 'settings')
    const offB = push(true, ['pengaturan', 'struk'], calls, 'struk')
    expect(guardCovers(['pengaturan', 'operasional'])).toBe(true) // struk is left
    expect(await confirmLeave(['pengaturan', 'operasional'])).toBe(true)
    expect(calls).toEqual(['struk'])
    offB(); offA()
  })

  it('a guard that answered leave and then unregisters does not abandon the chain', async () => {
    const calls: string[] = []
    const offA = push(true, ['pengaturan'], calls, 'settings')
    let offB = () => {}
    offB = pushLeaveGuard(async () => { calls.push('struk'); offB(); return true }, { scope: ['pengaturan', 'struk'] })
    expect(await confirmLeave(['produk'])).toBe(true)
    expect(calls).toEqual(['struk', 'settings'])
    offA()
  })

  it('a guard removed before its turn is skipped', async () => {
    const calls: string[] = []
    let offA = () => {}
    offA = push(true, ['pengaturan'], calls, 'settings')
    const offB = pushLeaveGuard(async () => { calls.push('struk'); offA(); return true }, { scope: ['pengaturan', 'struk'] })
    expect(await confirmLeave(['produk'])).toBe(true)
    expect(calls).toEqual(['struk'])
    offB()
  })

  it('asking again while the chain is open returns the same promise and asks nothing new', async () => {
    const calls: string[] = []
    let answerTop!: (leave: boolean) => void
    const offA = push(true, ['pengaturan'], calls, 'settings')
    const offB = pushLeaveGuard(() => new Promise<boolean>((r) => { answerTop = r }), { scope: ['pengaturan', 'struk'] })
    const first = confirmLeave(['produk'])
    const second = confirmLeave(['produk'])
    expect(second).toBe(first)
    answerTop(true)
    expect(await first).toBe(true)
    expect(calls).toEqual(['settings'])
    offB(); offA()
  })
})

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

  it('asks every guard top-down; a stay on the top never asks the one below', async () => {
    const low = vi.fn(async () => false)
    const high = vi.fn(async () => true)
    const offLow = pushLeaveGuard(low)
    const offHigh = pushLeaveGuard(high)
    expect(await confirmLeave()).toBe(false)
    expect(high).toHaveBeenCalledTimes(1)
    expect(low).toHaveBeenCalledTimes(1)
    offHigh()
    const stay = vi.fn(async () => false)
    const offStay = pushLeaveGuard(stay)
    expect(await confirmLeave()).toBe(false)
    expect(stay).toHaveBeenCalledTimes(1)
    expect(low).toHaveBeenCalledTimes(1) // not asked again
    offStay()
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
