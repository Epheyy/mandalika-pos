import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutoPullScheduler, AUTO_PULL } from './autoPull'

// Pure scheduler: when to fire, never what a pull does. Fake timers + a controllable random().

let rnd = 0.5
let fired: number[]
let s: AutoPullScheduler
const logs: string[] = []

function make(onRun?: () => void) {
  fired = []
  logs.length = 0
  s = new AutoPullScheduler({
    now: () => Date.now(),
    random: () => rnd,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    run: () => { fired.push(Date.now()); onRun?.() },
    log: (m) => logs.push(m),
  })
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); rnd = 0.5; make() })
afterEach(() => { s.cancel(); vi.useRealTimers() })

const T0 = 1_000_000
const BIG = 1_000 * 3_600_000 // a base far from epoch 0, so setting the clock back never goes negative

describe('AutoPullScheduler', () => {
  it('a raise fires exactly once inside the 5-15 s jitter window', () => {
    rnd = 0
    s.wantPull()
    vi.advanceTimersByTime(AUTO_PULL.JITTER_MIN_MS - 1)
    expect(fired).toEqual([])
    vi.advanceTimersByTime(1)
    expect(fired).toEqual([T0 + 5_000])
    vi.advanceTimersByTime(60_000)
    expect(fired).toHaveLength(1)
  })

  it('jitter upper bound is 15 s', () => {
    rnd = 0.999999
    s.wantPull()
    vi.advanceTimersByTime(15_000)
    expect(fired).toHaveLength(1)
  })

  it('a second wantPull without restart keeps the pending timer', () => {
    rnd = 0
    s.wantPull()
    vi.advanceTimersByTime(3_000)
    s.wantPull()
    vi.advanceTimersByTime(2_000)
    expect(fired).toHaveLength(1)
  })

  it('restarts push the fire time out but never past 120 s from first detection', () => {
    rnd = 0.999999 // 15 s every time
    s.wantPull()
    for (let i = 0; i < 12; i++) {
      vi.advanceTimersByTime(10_000)
      if (fired.length) break
      s.wantPull(true)
    }
    expect(fired).toHaveLength(1)
    expect(fired[0] - T0).toBeLessThanOrEqual(AUTO_PULL.MAX_WAIT_MS)
    expect(fired[0] - T0).toBeGreaterThan(60_000)
  })

  it('enforces the 60 s floor between attempt starts', () => {
    rnd = 0
    s.attemptStarted()
    s.wantPull()
    vi.advanceTimersByTime(59_999)
    expect(fired).toEqual([])
    vi.advanceTimersByTime(1)
    expect(fired).toHaveLength(1)
  })

  it('backoff doubles 30 s -> 60 s -> ... capped at 10 min and resets on success', () => {
    rnd = 1 // full step (jitter is 50-100%)
    const expected = [30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]
    for (const ms of expected) {
      const before = Date.now()
      s.failed()
      expect(s.backoffUntil() - before).toBe(ms)
    }
    s.succeeded()
    expect(s.backoffUntil()).toBe(0)
    s.failed()
    expect(s.backoffUntil() - Date.now()).toBe(30_000)
  })

  it('backoff jitter lower bound is 50% of the step', () => {
    rnd = 0
    s.failed()
    expect(s.backoffUntil() - Date.now()).toBe(15_000)
  })

  it('a pending wantPull waits for the backoff; resetBackoff (online) clears it', () => {
    rnd = 1
    s.failed()
    s.failed() // 60 s
    s.wantPull()
    vi.advanceTimersByTime(59_000)
    expect(fired).toEqual([])
    vi.advanceTimersByTime(1_000)
    expect(fired).toHaveLength(1)

    s.failed()
    s.resetBackoff()
    s.wantPull()
    vi.advanceTimersByTime(15_000)
    expect(fired).toHaveLength(2)
  })

  it('a 4xx suspends scheduling until resume()', () => {
    s.suspend()
    s.wantPull()
    s.markWaiting()
    s.nudge()
    vi.advanceTimersByTime(10 * 60_000)
    expect(fired).toEqual([])
    expect(s.isSuspended()).toBe(true)
    s.resume()
    s.wantPull()
    vi.advanceTimersByTime(15_000)
    expect(fired).toHaveLength(1)
  })

  it('suspend drops a pending timer', () => {
    s.wantPull()
    s.suspend()
    vi.advanceTimersByTime(60_000)
    expect(fired).toEqual([])
  })

  it('caps auto pulls at 20 per rolling hour, logs once, and recovers as the window rolls', () => {
    for (let i = 0; i < AUTO_PULL.HOURLY_CAP; i++) {
      s.attemptStarted()
      vi.advanceTimersByTime(61_000)
    }
    expect(s.isCapped()).toBe(true)
    s.wantPull()
    s.wantPull()
    vi.advanceTimersByTime(30_000)
    expect(fired).toEqual([])
    expect(logs).toHaveLength(1)
    vi.advanceTimersByTime(AUTO_PULL.HOUR_MS)
    s.wantPull()
    vi.advanceTimersByTime(15_000)
    expect(fired).toHaveLength(1)
  })

  it('waiting for idle holds no timer; a nudge fires within 2-5 s', () => {
    s.markWaiting()
    expect(s.isWaiting()).toBe(true)
    expect(s.isScheduled()).toBe(false)
    vi.advanceTimersByTime(120_000)
    expect(fired).toEqual([])
    rnd = 0
    s.nudge()
    vi.advanceTimersByTime(1_999)
    expect(fired).toEqual([])
    vi.advanceTimersByTime(1)
    expect(fired).toHaveLength(1)
    expect(s.isWaiting()).toBe(false)
  })

  it('nudge does nothing when not waiting', () => {
    s.nudge()
    vi.advanceTimersByTime(60_000)
    expect(fired).toEqual([])
  })

  it('nudge upper bound is 5 s', () => {
    rnd = 0.999999
    s.markWaiting()
    s.nudge()
    vi.advanceTimersByTime(5_000)
    expect(fired).toHaveLength(1)
  })

  it('retryIn fires after the given delay', () => {
    s.retryIn(3_000)
    vi.advanceTimersByTime(2_999)
    expect(fired).toEqual([])
    vi.advanceTimersByTime(1)
    expect(fired).toHaveLength(1)
  })

  it('cancel clears the timer; nothing fires after it', () => {
    s.wantPull()
    s.cancel()
    expect(s.isScheduled()).toBe(false)
    vi.advanceTimersByTime(10 * 60_000)
    expect(fired).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('50 raises in 10 minutes cause at most 10 attempts when each fire starts an attempt', () => {
    rnd = 0
    make(() => s.attemptStarted())
    for (let i = 0; i < 50; i++) {
      s.wantPull(true)
      vi.advanceTimersByTime(12_000)
    }
    expect(fired.length).toBeLessThanOrEqual(10)
    expect(fired.length).toBeGreaterThan(0)
  })

  it('a backward clock jump does not starve past the 60 s floor', () => {
    vi.setSystemTime(BIG)
    rnd = 0
    s.attemptStarted()
    vi.setSystemTime(BIG - 2 * 3_600_000) // clock set back two hours
    s.wantPull()
    vi.advanceTimersByTime(60_000)
    expect(fired).toHaveLength(1)
  })

  it('a backward jump cannot leave a failure backoff beyond its 10 min cap', () => {
    vi.setSystemTime(BIG)
    rnd = 1
    s.failed()
    s.failed()
    s.failed()
    s.failed()
    s.failed()
    s.failed() // capped step
    vi.setSystemTime(BIG - 5 * 3_600_000)
    s.wantPull()
    vi.advanceTimersByTime(AUTO_PULL.BACKOFF_CAP_MS)
    expect(fired).toHaveLength(1)
  })

  it('never arms a timer longer than one hour', () => {
    vi.setSystemTime(BIG)
    s.attemptStarted()
    vi.setSystemTime(BIG - 10 * 3_600_000)
    s.failed()
    vi.setSystemTime(BIG + 50 * 3_600_000)
    s.wantPull()
    const spy = vi.spyOn(globalThis, 'setTimeout')
    s.cancel()
    s.wantPull()
    for (const call of spy.mock.calls) expect(Number(call[1])).toBeLessThanOrEqual(3_600_000)
    expect(Number.isFinite(Number(spy.mock.calls.at(-1)?.[1]))).toBe(true)
  })

  it('a forward jump of 3 days arms a bounded timer and does not loop', () => {
    rnd = 0
    s.attemptStarted()
    vi.setSystemTime(T0 + 3 * 86_400_000)
    s.wantPull()
    vi.advanceTimersByTime(15_000)
    expect(fired).toHaveLength(1)
    vi.advanceTimersByTime(60_000)
    expect(fired).toHaveLength(1)
  })

  describe('stock kind (A15 phase B)', () => {
    it('stock has its own 300 s floor counted from the last auto pull of either kind', () => {
      rnd = 0
      s.attemptStarted('data')
      s.wantPull(false, 'stock')
      vi.advanceTimersByTime(AUTO_PULL.STOCK_FLOOR_MS - 1)
      expect(fired).toEqual([])
      vi.advanceTimersByTime(1)
      expect(fired).toHaveLength(1)
    })

    it('a stock attempt does not delay a data pull (the data budget is separate)', () => {
      rnd = 0
      s.attemptStarted('stock')
      s.wantPull(false, 'data')
      vi.advanceTimersByTime(AUTO_PULL.JITTER_MIN_MS)
      expect(fired).toHaveLength(1)
    })

    it('the stock cap is 10 per rolling hour and leaves the data cap alone', () => {
      rnd = 0
      for (let i = 0; i < AUTO_PULL.STOCK_HOURLY_CAP; i++) s.attemptStarted('stock')
      expect(s.isCapped('stock')).toBe(true)
      expect(s.isCapped()).toBe(false)
      s.wantPull(false, 'stock')
      expect(s.isScheduled()).toBe(false)
      expect(logs.some((l) => l.includes('stock'))).toBe(true)
      s.wantPull(false, 'data')
      expect(s.isScheduled()).toBe(true)
      s.cancel()
      vi.advanceTimersByTime(AUTO_PULL.HOUR_MS)
      expect(s.isCapped('stock')).toBe(false)
    })

    it('a stock attempt never uses up the 20/h data budget', () => {
      for (let i = 0; i < 15; i++) s.attemptStarted('stock')
      expect(s.isCapped()).toBe(false)
    })

    it('a data want replaces an armed stock timer; a stock want keeps an armed data timer', () => {
      rnd = 0
      s.wantPull(false, 'stock')
      expect(s.armedKind()).toBe('stock')
      s.wantPull(false, 'data')
      expect(s.armedKind()).toBe('data')
      s.wantPull(false, 'stock')
      expect(s.armedKind()).toBe('data')
      vi.advanceTimersByTime(AUTO_PULL.JITTER_MIN_MS)
      expect(fired).toHaveLength(1) // fired as data, not held to the stock floor
    })

    it('the timer reports the kind it was armed for', () => {
      rnd = 0
      const seen: unknown[] = []
      s.cancel()
      s = new AutoPullScheduler({
        now: () => Date.now(), random: () => rnd,
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        run: (kind) => seen.push(kind),
      })
      s.wantPull(false, 'stock')
      vi.advanceTimersByTime(AUTO_PULL.JITTER_MIN_MS)
      expect(seen).toEqual(['stock'])
    })

    it('retryIn keeps the stock floor, waiting remembers the kind for a nudge', () => {
      rnd = 0
      s.attemptStarted('stock')
      s.retryIn(AUTO_PULL.FLUSHING_RECHECK_MS, 'stock')
      vi.advanceTimersByTime(AUTO_PULL.STOCK_FLOOR_MS - 1)
      expect(fired).toEqual([])
      vi.advanceTimersByTime(1)
      expect(fired).toHaveLength(1)
      s.markWaiting('stock')
      s.nudge()
      expect(s.armedKind()).toBe('stock')
    })
  })
})
