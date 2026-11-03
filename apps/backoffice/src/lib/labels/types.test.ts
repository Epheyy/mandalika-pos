import { describe, expect, it } from 'vitest'
import { labelOf, type LabelMap } from './types'

const MAP: LabelMap<'a' | 'b'> = {
  a: { label: 'Aktif', tone: 'ok' },
  b: { label: 'Mati', tone: 'danger', hint: 'dimatikan' },
}

describe('labelOf', () => {
  it('returns the entry for a known code', () => {
    expect(labelOf(MAP, 'a')).toEqual({ label: 'Aktif', tone: 'ok' })
    expect(labelOf(MAP, 'b').hint).toBe('dimatikan')
  })

  it('reads Lainnya with the code as the hint for an unknown code', () => {
    expect(labelOf(MAP, 'zzz')).toEqual({ label: 'Lainnya', tone: 'neutral', hint: 'zzz' })
  })

  it('handles null, undefined and empty without leaking', () => {
    expect(labelOf(MAP, null)).toEqual({ label: 'Lainnya', tone: 'neutral', hint: undefined })
    expect(labelOf(MAP, undefined).label).toBe('Lainnya')
    expect(labelOf(MAP, '').hint).toBe('')
  })

  it('does not resolve inherited object keys', () => {
    expect(labelOf(MAP, 'toString').label).toBe('Lainnya')
    expect(labelOf(MAP, 'constructor').label).toBe('Lainnya')
  })
})
