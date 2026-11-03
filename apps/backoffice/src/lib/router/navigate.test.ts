import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pushLeaveGuard } from '../navGuard'
import { createRouter, type HistoryEnv } from './navigate'

/**
 * A session history that behaves like the browser's: pushState cuts the Forward entries, go() lands later
 * (as a task, not synchronously) and fires popstate and then hashchange when the hash differs, and an entry
 * the router did not create has no idx.
 */
class FakeBrowser implements HistoryEnv {
  entries: { hash: string; idx: number | null }[]
  cursor = 0
  private listeners = new Set<() => void>()
  constructor(initialHash: string, initialIdx: number | null = null) {
    this.entries = [{ hash: initialHash, idx: initialIdx }]
  }
  hash = () => this.entries[this.cursor].hash
  stateIdx = () => this.entries[this.cursor].idx
  stamp = (idx: number) => {
    this.entries[this.cursor].idx = idx
  }
  push = (idx: number, hash: string) => {
    this.entries.splice(this.cursor + 1)
    this.entries.push({ hash, idx })
    this.cursor += 1
  }
  replace = (idx: number, hash: string) => {
    this.entries[this.cursor] = { hash, idx }
  }
  go = (delta: number) => {
    setTimeout(() => {
      const to = Math.min(Math.max(this.cursor + delta, 0), this.entries.length - 1)
      if (to === this.cursor) return
      const hashChanged = this.entries[to].hash !== this.entries[this.cursor].hash
      this.cursor = to
      this.fire(hashChanged)
    }, 0)
  }
  listen = (onChange: () => void) => {
    this.listeners.add(onChange)
    return () => {
      this.listeners.delete(onChange)
    }
  }
  /** The user presses the browser's Back / Forward button. */
  back = () => this.go(-1)
  forward = () => this.go(1)
  /** The user edits the URL bar or follows a plain "#..." link: a push without our stamp. */
  typeUrl(hash: string) {
    setTimeout(() => {
      this.entries.splice(this.cursor + 1)
      this.entries.push({ hash, idx: null })
      this.cursor += 1
      this.fire(true)
    }, 0)
  }
  private fire(hashChanged: boolean) {
    for (const l of [...this.listeners]) l() // popstate
    if (hashChanged) for (const l of [...this.listeners]) l() // hashchange
  }
  hashes = () => this.entries.map((e) => e.hash)
  current = () => this.entries[this.cursor].hash
}

// The fake history lands go() in a timer, like a browser task; fake timers make that deterministic.
const settle = () => vi.advanceTimersByTimeAsync(50)

/** A guard whose answer the test gives later, like a dialog the user has not answered yet. */
function openQuestion() {
  let answer!: (leave: boolean) => void
  const asked = vi.fn()
  const off = pushLeaveGuard(
    () =>
      new Promise<boolean>((resolve) => {
        asked()
        answer = resolve
      }),
  )
  return { asked, answer: (leave: boolean) => answer(leave), off }
}

const offs: Array<() => void> = []
beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  while (offs.length) offs.pop()?.()
  vi.useRealTimers()
})

/** Three entries A B C with the browser on C, no guard yet. */
async function threeEntries() {
  const env = new FakeBrowser('#/a')
  const router = createRouter(env)
  await router.navigate('#/b')
  await router.navigate('#/c')
  return { env, router }
}

describe('navigate without a guard', () => {
  it('stamps the first entry and reads the location', () => {
    const env = new FakeBrowser('#/laporan/refund?status=open')
    const router = createRouter(env)
    expect(router.getLocation()).toEqual({ path: ['laporan', 'refund'], query: { status: 'open' } })
    expect(env.stateIdx()).toBe(0)
  })

  it('keeps the idx of a reloaded entry and counts on from it', async () => {
    const env = new FakeBrowser('#/x', 4)
    const router = createRouter(env)
    expect(env.stateIdx()).toBe(4)
    await router.navigate('#/y')
    expect(env.stateIdx()).toBe(5)
  })

  it('pushes a new entry, notifies, and counts the idx up', async () => {
    const env = new FakeBrowser('#/a')
    const router = createRouter(env)
    const listener = vi.fn()
    router.subscribe(listener)
    expect(await router.navigate('#/b?x=1')).toBe(true)
    expect(env.hashes()).toEqual(['#/a', '#/b?x=1'])
    expect(env.stateIdx()).toBe(1)
    expect(router.getLocation().path).toEqual(['b'])
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the target is where it already is, whatever the spelling', async () => {
    const env = new FakeBrowser('#/a?x=1')
    const router = createRouter(env)
    expect(await router.navigate('/a?x=1')).toBe(true)
    expect(env.entries).toHaveLength(1)
  })

  it('replace swaps the current entry instead of adding one', async () => {
    const env = new FakeBrowser('#/a')
    const router = createRouter(env)
    await router.navigate('#/b', { replace: true })
    expect(env.hashes()).toEqual(['#/b'])
    expect(env.stateIdx()).toBe(0)
  })

  it('follows Back and Forward', async () => {
    const { env, router } = await threeEntries()
    env.back()
    await settle()
    expect(router.getLocation().path).toEqual(['b'])
    env.forward()
    await settle()
    expect(router.getLocation().path).toEqual(['c'])
  })

  it('adopts a typed URL as a push', async () => {
    const { env, router } = await threeEntries()
    env.typeUrl('#/typed')
    await settle()
    expect(router.getLocation().path).toEqual(['typed'])
    expect(env.stateIdx()).toBe(3)
    env.back()
    await settle()
    expect(router.getLocation().path).toEqual(['c'])
  })

  it('stops notifying after unsubscribe', async () => {
    const env = new FakeBrowser('#/a')
    const router = createRouter(env)
    const listener = vi.fn()
    const off = router.subscribe(listener)
    off()
    await router.navigate('#/b')
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('navigate with a leave guard', () => {
  it('refused: nothing moves and false comes back', async () => {
    const { env, router } = await threeEntries()
    const q = openQuestion()
    offs.push(q.off)
    const moved = router.navigate('#/d')
    await settle()
    expect(q.asked).toHaveBeenCalledTimes(1)
    q.answer(false)
    expect(await moved).toBe(false)
    expect(env.hashes()).toEqual(['#/a', '#/b', '#/c'])
    expect(router.getLocation().path).toEqual(['c'])
  })

  it('allowed: the move happens after the answer', async () => {
    const { env, router } = await threeEntries()
    const q = openQuestion()
    offs.push(q.off)
    const moved = router.navigate('#/d')
    await settle()
    expect(env.current()).toBe('#/c')
    q.answer(true)
    expect(await moved).toBe(true)
    expect(env.hashes()).toEqual(['#/a', '#/b', '#/c', '#/d'])
  })

  it('does not ask for a move to the same place', async () => {
    const { router } = await threeEntries()
    const q = openQuestion()
    offs.push(q.off)
    expect(await router.navigate('#/c')).toBe(true)
    expect(q.asked).not.toHaveBeenCalled()
  })

  it('refuses a second move while a question is open', async () => {
    const { router } = await threeEntries()
    const q = openQuestion()
    offs.push(q.off)
    const first = router.navigate('#/d')
    await settle()
    expect(await router.navigate('#/e')).toBe(false)
    expect(q.asked).toHaveBeenCalledTimes(1)
    q.answer(false)
    await first
  })
})

describe('a guard scoped to its own screen', () => {
  const scoped = () => {
    const ask = vi.fn(async () => false)
    offs.push(pushLeaveGuard(ask, { scope: ['pengaturan'] }))
    return ask
  }

  it('moves between its own tabs without asking, and asks for a move out', async () => {
    const env = new FakeBrowser('#/pengaturan/outlet-gudang')
    const router = createRouter(env)
    const ask = scoped()
    expect(await router.navigate('#/pengaturan/transaksi')).toBe(true)
    expect(ask).not.toHaveBeenCalled()
    expect(await router.navigate('#/laporan')).toBe(false)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(env.current()).toBe('#/pengaturan/transaksi')
  })

  it('follows Back and Forward between its own tabs without asking', async () => {
    const env = new FakeBrowser('#/pengaturan/outlet-gudang')
    const router = createRouter(env)
    await router.navigate('#/pengaturan/transaksi')
    const ask = scoped()
    env.back()
    await settle()
    expect(router.getLocation().path).toEqual(['pengaturan', 'outlet-gudang'])
    env.forward()
    await settle()
    expect(router.getLocation().path).toEqual(['pengaturan', 'transaksi'])
    expect(ask).not.toHaveBeenCalled()
  })

  it('adopts a typed URL inside its scope and still guards one outside it', async () => {
    const env = new FakeBrowser('#/pengaturan/outlet-gudang')
    const router = createRouter(env)
    const ask = scoped()
    env.typeUrl('#/pengaturan/operasional')
    await settle()
    expect(router.getLocation().path).toEqual(['pengaturan', 'operasional'])
    expect(ask).not.toHaveBeenCalled()
    env.typeUrl('#/laporan')
    await settle()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(env.current()).toBe('#/pengaturan/operasional')
    expect(router.getLocation().path).toEqual(['pengaturan', 'operasional'])
  })

  it('a refused Back out of the scope keeps Forward history', async () => {
    const env = new FakeBrowser('#/laporan/refund')
    const router = createRouter(env)
    await router.navigate('#/pengaturan/outlet-gudang')
    await router.navigate('#/pengaturan/transaksi')
    const ask = scoped()
    env.back() // to outlet-gudang: inside the scope, no question
    await settle()
    env.back() // to laporan: out of scope, refused
    await settle()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(env.current()).toBe('#/pengaturan/outlet-gudang')
    env.forward()
    await settle()
    expect(router.getLocation().path).toEqual(['pengaturan', 'transaksi'])
  })
})

describe('leave guard edge cases', () => {
  it('a guard that goes away with its question open does not lock the router', async () => {
    const { env, router } = await threeEntries()
    const off = pushLeaveGuard(() => new Promise<boolean>(() => {})) // a screen that unmounts unanswered
    const moved = router.navigate('#/d')
    await settle()
    off()
    expect(await moved).toBe(false)
    expect(await router.navigate('#/d')).toBe(true)
    expect(env.current()).toBe('#/d')
    env.back()
    await settle()
    expect(router.getLocation().path).toEqual(['c'])
  })

  it('a typed alias of the current hash is stamped, so a later Back and Forward keep their order', async () => {
    const { env, router } = await threeEntries()
    env.typeUrl('#c') // same place, new entry, no idx
    await settle()
    expect(env.stateIdx()).toBe(3)
    expect(router.getLocation().path).toEqual(['c'])
    env.back()
    await settle()
    expect(env.stateIdx()).toBe(2)
    env.forward()
    await settle()
    expect(env.stateIdx()).toBe(3)
  })

  it('a quick yes during a Back pushes from the entry the screen was on', async () => {
    const { env, router } = await threeEntries()
    const q = openQuestion()
    offs.push(q.off)
    const moved = router.navigate('#/d')
    await settle()
    env.back() // Back while the sidebar question is open
    await vi.advanceTimersToNextTimerAsync() // the Back has landed on b; its undo is still in flight
    expect(env.current()).toBe('#/b')
    q.answer(true)
    await settle()
    expect(await moved).toBe(true)
    expect(env.hashes()).toEqual(['#/a', '#/b', '#/c', '#/d'])
    expect(env.current()).toBe('#/d')
  })
})

describe('browser Back and Forward with a leave guard', () => {
  it('Back refused: the hash is put back, Forward history survives, the guard is asked once', async () => {
    const { env, router } = await threeEntries()
    const q = openQuestion()
    offs.push(q.off)
    env.back()
    await settle()
    // Undone while the question is open: the screen never left C.
    expect(env.current()).toBe('#/c')
    expect(router.getLocation().path).toEqual(['c'])
    expect(q.asked).toHaveBeenCalledTimes(1)
    q.answer(false)
    await settle()
    expect(env.hashes()).toEqual(['#/a', '#/b', '#/c'])
    expect(env.current()).toBe('#/c')
    expect(env.stateIdx()).toBe(2)
    expect(router.getLocation().path).toEqual(['c'])
  })

  it('Back refused, then a later Back asks again and Forward after a leave still works', async () => {
    const { env, router } = await threeEntries()
    const q = openQuestion()
    offs.push(q.off)
    env.back()
    await settle()
    q.answer(false)
    await settle()
    q.off()
    env.back()
    await settle()
    expect(router.getLocation().path).toEqual(['b'])
    env.forward()
    await settle()
    expect(router.getLocation().path).toEqual(['c'])
  })

  it('Back allowed: it ends on the previous entry without a second question', async () => {
    const { env, router } = await threeEntries()
    const q = openQuestion()
    offs.push(q.off)
    env.back()
    await settle()
    q.answer(true)
    await settle()
    expect(env.current()).toBe('#/b')
    expect(env.hashes()).toEqual(['#/a', '#/b', '#/c'])
    expect(router.getLocation().path).toEqual(['b'])
    expect(q.asked).toHaveBeenCalledTimes(1)
  })

  it('Forward refused: put back on the entry it left', async () => {
    const { env, router } = await threeEntries()
    env.back()
    await settle()
    expect(router.getLocation().path).toEqual(['b'])
    const q = openQuestion()
    offs.push(q.off)
    env.forward()
    await settle()
    expect(env.current()).toBe('#/b')
    q.answer(false)
    await settle()
    expect(env.current()).toBe('#/b')
    expect(router.getLocation().path).toEqual(['b'])
    expect(env.hashes()).toEqual(['#/a', '#/b', '#/c'])
  })

  it('a multi-step Back (long-press) is undone to where the screen was', async () => {
    const { env, router } = await threeEntries()
    const q = openQuestion()
    offs.push(q.off)
    env.go(-2)
    await settle()
    expect(env.current()).toBe('#/c')
    q.answer(false)
    await settle()
    expect(router.getLocation().path).toEqual(['c'])
    expect(env.hashes()).toEqual(['#/a', '#/b', '#/c'])
  })

  it('a multi-step Back that is allowed lands on the entry the user chose', async () => {
    const { env, router } = await threeEntries()
    const q = openQuestion()
    offs.push(q.off)
    env.go(-2)
    await settle()
    q.answer(true)
    await settle()
    expect(env.current()).toBe('#/a')
    expect(router.getLocation().path).toEqual(['a'])
  })

  it('a typed URL refused: put back, nothing pushed that stays visible', async () => {
    const { env, router } = await threeEntries()
    const q = openQuestion()
    offs.push(q.off)
    env.typeUrl('#/typed')
    await settle()
    expect(env.current()).toBe('#/c')
    q.answer(false)
    await settle()
    expect(router.getLocation().path).toEqual(['c'])
    expect(env.current()).toBe('#/c')
  })

  it('a typed URL allowed: it opens as a push', async () => {
    const { env, router } = await threeEntries()
    const q = openQuestion()
    offs.push(q.off)
    env.typeUrl('#/typed')
    await settle()
    q.answer(true)
    await settle()
    expect(router.getLocation().path).toEqual(['typed'])
    expect(env.current()).toBe('#/typed')
    expect(env.stateIdx()).toBe(3)
  })

  it('a router move while a Back question is open is refused', async () => {
    const { env, router } = await threeEntries()
    const q = openQuestion()
    offs.push(q.off)
    env.back()
    await settle()
    expect(await router.navigate('#/z')).toBe(false)
    q.answer(false)
    await settle()
    expect(router.getLocation().path).toEqual(['c'])
  })
})
