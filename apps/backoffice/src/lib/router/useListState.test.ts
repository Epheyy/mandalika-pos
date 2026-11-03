import { describe, expect, it } from 'vitest'
import { parseListState, serializeListState, type ListSchema } from './useListState'

interface Filters extends Record<string, string | number | boolean> {
  q: string
  hal: number
  aktif: boolean
  status: string
}
const schema: ListSchema<Filters> = {
  q: { key: 'q', default: '' },
  hal: { key: 'hal', default: 1 },
  aktif: { key: 'aktif', default: false },
  status: { key: 'status', default: 'open' },
}

describe('parseListState', () => {
  it('gives the defaults for an empty query', () => {
    expect(parseListState(schema, {})).toEqual({ q: '', hal: 1, aktif: false, status: 'open' })
  })

  it('reads each type by its default', () => {
    expect(parseListState(schema, { q: 'lilin', hal: '3', aktif: '1', status: 'dead' })).toEqual({
      q: 'lilin',
      hal: 3,
      aktif: true,
      status: 'dead',
    })
  })

  it('falls back to the default for a number or boolean that does not parse', () => {
    expect(parseListState(schema, { hal: 'abc', aktif: 'mungkin' })).toMatchObject({ hal: 1, aktif: false })
    expect(parseListState(schema, { hal: '' })).toMatchObject({ hal: 1 })
    expect(parseListState(schema, { hal: 'Infinity' })).toMatchObject({ hal: 1 })
  })

  it('accepts "true" and "0"/"false" for booleans', () => {
    expect(parseListState(schema, { aktif: 'true' }).aktif).toBe(true)
    const on: ListSchema<Filters> = { ...schema, aktif: { key: 'aktif', default: true } }
    expect(parseListState(on, { aktif: '0' }).aktif).toBe(false)
    expect(parseListState(on, { aktif: 'false' }).aktif).toBe(false)
  })

  it('uses the field key, not the state name', () => {
    const renamed: ListSchema<Filters> = { ...schema, hal: { key: 'halaman', default: 1 } }
    expect(parseListState(renamed, { halaman: '4', hal: '9' }).hal).toBe(4)
  })
})

describe('serializeListState', () => {
  it('omits values that equal their default', () => {
    expect(serializeListState(schema, { q: '', hal: 1, aktif: false, status: 'open' })).toEqual({
      q: undefined,
      hal: undefined,
      aktif: undefined,
      status: undefined,
    })
  })

  it('writes what differs', () => {
    expect(serializeListState(schema, { q: 'lilin', hal: 2, aktif: true, status: 'dead' })).toEqual({
      q: 'lilin',
      hal: 2,
      aktif: true,
      status: 'dead',
    })
  })

  it('round-trips through parse', () => {
    const state: Filters = { q: 'a b', hal: 5, aktif: true, status: 'dead' }
    const query = Object.fromEntries(
      Object.entries(serializeListState(schema, state))
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)]),
    )
    expect(parseListState(schema, query)).toEqual(state)
  })
})
