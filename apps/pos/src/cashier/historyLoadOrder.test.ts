import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LatestLoad } from './orderHistoryQuery'

// Riwayat fires a new load whenever the day, page or search changes. Without an ordering rule a slow response for the
// old filters lands after the new one and the cashier sees the wrong day's sales, and its `finally` hides the spinner
// while the newer load is still running.
describe('LatestLoad (only the newest history load may write the panel)', () => {
  it('a lone load is current', () => {
    const gate = new LatestLoad()
    const t = gate.begin()
    expect(gate.isCurrent(t)).toBe(true)
  })

  it('an older load stops being current once a newer one starts, whichever answers first', () => {
    const gate = new LatestLoad()
    const older = gate.begin()
    const newer = gate.begin()
    expect(gate.isCurrent(older)).toBe(false)
    expect(gate.isCurrent(newer)).toBe(true)
  })

  it('tickets never repeat', () => {
    const gate = new LatestLoad()
    const seen = new Set([gate.begin(), gate.begin(), gate.begin()])
    expect(seen.size).toBe(3)
  })
})

describe('OrderHistoryPanel.load is wired through LatestLoad', () => {
  const src = readFileSync(new URL('./OrderHistoryPanel.tsx', import.meta.url), 'utf8')
  const start = src.indexOf('const load = useCallback(async () => {')
  const body = src.slice(start, src.indexOf('}, [from, to, page, search, focus', start))
  const tryPart = body.slice(body.indexOf('try {'), body.indexOf('} catch'))
  const catchPart = body.slice(body.indexOf('} catch'), body.indexOf('} finally'))
  const finallyPart = body.slice(body.indexOf('} finally'))

  it('takes a ticket before the request', () => {
    expect(start).toBeGreaterThan(-1)
    expect(body.indexOf('const ticket = loadGate.begin()')).toBeGreaterThan(-1)
    expect(body.indexOf('const ticket = loadGate.begin()')).toBeLessThan(body.indexOf('await api.request'))
  })

  it('drops a superseded response before writing the list', () => {
    const guard = tryPart.indexOf('if (!loadGate.isCurrent(ticket)) return')
    expect(guard).toBeGreaterThan(tryPart.indexOf('await api.request'))
    expect(guard).toBeLessThan(tryPart.indexOf('setOrders(data)'))
  })

  it('drops a superseded pinned-order fetch', () => {
    expect(tryPart).toContain('const one = await api.getOrder(focus.orderId)')
    expect(tryPart).toMatch(/if \(loadGate\.isCurrent\(ticket\)\) setPinned\(one\)/)
  })

  it('a superseded failure does not swap in cached rows or an error', () => {
    const guard = catchPart.indexOf('if (!loadGate.isCurrent(ticket)) return')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(catchPart.indexOf('setOrders('))
  })

  it('only the newest load ends the loading state', () => {
    expect(finallyPart).toContain('if (loadGate.isCurrent(ticket)) setIsLoading(false)')
  })
})
