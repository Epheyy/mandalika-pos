import { describe, expect, it } from 'vitest'
import { TONES, toneClasses } from './tone'

describe('toneClasses', () => {
  it.each(TONES)('returns background and text classes for %s', (tone) => {
    const classes = toneClasses(tone)
    expect(classes).toMatch(/bg-/)
    expect(classes).toMatch(/text-/)
  })

  it('uses the -bg token as background and the base token as text for status tones', () => {
    expect(toneClasses('ok')).toBe('bg-ok-bg text-ok')
    expect(toneClasses('danger')).toBe('bg-danger-bg text-danger')
  })
})
