import { describe, expect, it } from 'vitest'
import { installKeyboardInset, KEYBOARD_MIN_INSET_PX, keyboardInsetPx } from './keyboardInset'

const vv = (height: number, offsetTop = 0, scale = 1) => ({ height, offsetTop, scale })

describe('keyboardInsetPx', () => {
  it('is 0 when the keyboard is closed', () => {
    expect(keyboardInsetPx(601, vv(601))).toBe(0)
    expect(keyboardInsetPx(1006, vv(1006))).toBe(0)
  })
  it('measures the landscape and portrait keyboards from the device', () => {
    expect(keyboardInsetPx(601, vv(299))).toBe(302)
    expect(keyboardInsetPx(1006, vv(675))).toBe(331)
  })
  it('subtracts offsetTop and rounds to an integer', () => {
    expect(keyboardInsetPx(1000, vv(600.4, 50))).toBe(350)
  })
  it('is 0 under a pinch zoom', () => {
    expect(keyboardInsetPx(1006, vv(675, 0, 1.5))).toBe(0)
    expect(keyboardInsetPx(1006, vv(675, 0, 1.01))).toBe(331)
  })
  it('ignores toolbar jitter below the threshold', () => {
    expect(keyboardInsetPx(1006, vv(1006 - (KEYBOARD_MIN_INSET_PX - 1)))).toBe(0)
    expect(keyboardInsetPx(1006, vv(1006 - KEYBOARD_MIN_INSET_PX))).toBe(KEYBOARD_MIN_INSET_PX)
  })
  it('is never negative', () => {
    expect(keyboardInsetPx(600, vv(900))).toBe(0)
    expect(keyboardInsetPx(600, vv(600, 40))).toBe(0)
  })
})

type Listener = () => void
function fakeWindow(innerHeight: number, viewport: ReturnType<typeof vv> | null) {
  const style = new Map<string, string>()
  const vvListeners = new Map<string, Set<Listener>>()
  const winListeners = new Map<string, Set<Listener>>()
  const bucket = (m: Map<string, Set<Listener>>, t: string) => m.get(t) ?? m.set(t, new Set()).get(t)!
  const target = (m: Map<string, Set<Listener>>) => ({
    addEventListener: (t: string, l: Listener) => void bucket(m, t).add(l),
    removeEventListener: (t: string, l: Listener) => void bucket(m, t).delete(l),
  })
  const visual = viewport && { ...viewport, ...target(vvListeners) }
  const win = {
    innerHeight,
    visualViewport: visual,
    document: {
      documentElement: { style: { setProperty: (k: string, v: string) => style.set(k, v), removeProperty: (k: string) => style.delete(k) } },
      activeElement: null,
    },
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    ...target(winListeners),
  }
  const count = () => [...vvListeners.values(), ...winListeners.values()].reduce((n, s) => n + s.size, 0)
  return {
    win: win as unknown as Window & typeof globalThis,
    style,
    visual,
    fire: (t: string) => vvListeners.get(t)?.forEach((l) => l()),
    count,
  }
}

describe('installKeyboardInset', () => {
  it('is a no-op without visualViewport', () => {
    const f = fakeWindow(1006, null)
    expect(() => installKeyboardInset(f.win)()).not.toThrow()
    expect(f.style.size).toBe(0)
  })
  it('sets --kb from the visual viewport, follows resizes and cleans up', () => {
    const f = fakeWindow(1006, vv(1006))
    const cleanup = installKeyboardInset(f.win)
    expect(f.style.has('--kb')).toBe(false) // closed from the start: the CSS fallback (0px) applies
    f.visual!.height = 675
    f.fire('resize')
    expect(f.style.get('--kb')).toBe('331px')
    f.visual!.height = 1006
    f.fire('scroll')
    expect(f.style.get('--kb')).toBe('0px')
    expect(f.count()).toBe(3)
    cleanup()
    expect(f.count()).toBe(0)
    expect(f.style.has('--kb')).toBe(false)
  })
})
