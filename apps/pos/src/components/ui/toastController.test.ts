import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createToastController, DEFAULT_TOAST_DURATION } from './toastController'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('toast timer', () => {
  it('shows a toast for the default duration, then clears it', () => {
    const c = createToastController()
    c.show('Tersimpan')
    expect(c.getState()?.message).toBe('Tersimpan')
    vi.advanceTimersByTime(DEFAULT_TOAST_DURATION - 1)
    expect(c.getState()).not.toBeNull()
    vi.advanceTimersByTime(1)
    expect(c.getState()).toBeNull()
  })

  it('honours a per-toast duration', () => {
    const c = createToastController()
    c.show('Ditambahkan', { duration: 1600 })
    vi.advanceTimersByTime(1599)
    expect(c.getState()).not.toBeNull()
    vi.advanceTimersByTime(1)
    expect(c.getState()).toBeNull()
  })

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])('falls back to the default for an invalid duration (%s)', (duration) => {
    const c = createToastController()
    c.show('x', { duration })
    vi.advanceTimersByTime(DEFAULT_TOAST_DURATION - 1)
    expect(c.getState()).not.toBeNull()
    vi.advanceTimersByTime(1)
    expect(c.getState()).toBeNull()
  })

  it('restarts the timer on every show, so a later toast is not cut short by the first one', () => {
    const c = createToastController()
    c.show('pertama', { duration: 3000 })
    vi.advanceTimersByTime(2500)
    c.show('kedua', { duration: 3000 })
    vi.advanceTimersByTime(2500) // 5000 ms after the first show: its timer would have fired
    expect(c.getState()?.message).toBe('kedua')
    vi.advanceTimersByTime(500)
    expect(c.getState()).toBeNull()
  })

  it('gives each accepted toast a new id so the view can remount it', () => {
    const c = createToastController()
    c.show('a')
    const first = c.getState()!.id
    c.show('a')
    expect(c.getState()!.id).not.toBe(first)
  })

  it('dismiss(id) clears only that toast, so a stale caller cannot wipe a newer one', () => {
    const c = createToastController()
    const first = c.show('Ditambahkan')!
    c.show('Stok tidak cukup', { tone: 'warn' })
    c.dismiss(first)
    expect(c.getState()?.tone).toBe('warn')
    c.dismiss(c.getState()!.id)
    expect(c.getState()).toBeNull()
  })

  it('dismiss clears the toast and its timer', () => {
    const c = createToastController()
    c.show('x')
    c.dismiss()
    expect(c.getState()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('notifies subscribers on show and on clear, and stops after unsubscribe', () => {
    const c = createToastController()
    const listener = vi.fn()
    const off = c.subscribe(listener)
    c.show('x')
    vi.advanceTimersByTime(DEFAULT_TOAST_DURATION)
    expect(listener).toHaveBeenCalledTimes(2)
    off()
    c.show('y')
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe('toast precedence', () => {
  it('never replaces a warning with an info toast, and the warning keeps its own timer', () => {
    const c = createToastController()
    expect(c.show('Stok tidak cukup (OVERSELL_WARNING)', { tone: 'warn', duration: 4000 })).not.toBeNull()
    vi.advanceTimersByTime(1000)
    expect(c.show('Ditambahkan · Parfum', { duration: 1600 })).toBeNull()
    expect(c.getState()).toMatchObject({ tone: 'warn', message: 'Stok tidak cukup (OVERSELL_WARNING)' })
    vi.advanceTimersByTime(2999) // 3999 ms since the warning: the dropped info toast did not reset or shorten it
    expect(c.getState()).not.toBeNull()
    vi.advanceTimersByTime(1)
    expect(c.getState()).toBeNull()
  })

  it('lets an info toast show again once the warning is gone', () => {
    const c = createToastController()
    c.show('peringatan', { tone: 'warn', duration: 1000 })
    vi.advanceTimersByTime(1000)
    expect(c.show('Ditambahkan', { duration: 1600 })).not.toBeNull()
    expect(c.getState()?.message).toBe('Ditambahkan')
  })

  it('lets a higher or equal severity replace the visible toast', () => {
    const c = createToastController()
    c.show('info')
    expect(c.show('ok', { tone: 'ok' })).not.toBeNull()
    expect(c.show('peringatan', { tone: 'warn' })).not.toBeNull()
    expect(c.show('peringatan lain', { tone: 'warn' })).not.toBeNull()
    expect(c.show('gagal', { tone: 'danger' })).not.toBeNull()
    expect(c.getState()).toMatchObject({ tone: 'danger', message: 'gagal' })
    expect(c.show('peringatan', { tone: 'warn' })).toBeNull()
    expect(c.show('ok', { tone: 'ok' })).toBeNull()
  })

  it('treats a toast without a tone as info', () => {
    const c = createToastController()
    c.show('info')
    expect(c.getState()?.tone).toBe('info')
  })
})
