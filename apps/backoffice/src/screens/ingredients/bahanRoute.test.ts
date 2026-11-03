import { describe, expect, it } from 'vitest'
import { parseListState } from '../../lib/router/useListState'
import {
  BAHAN_TRANSFER_SCHEMA,
  DAFTAR_SCHEMA,
  bahanDayOf,
  bahanLocationOf,
  bahanPageOf,
  bahanSizeOf,
  categoryOf,
  transferStatusOf,
} from './bahanRoute'

const ID = '00000000-0000-4000-8f6b-0000000000a1'

describe('bahanRoute', () => {
  it('keeps defaults implicit', () => {
    expect(parseListState(DAFTAR_SCHEMA, {})).toEqual({ q: '', kategori: '', hal: 1, per: 25 })
    expect(parseListState(BAHAN_TRANSFER_SCHEMA, {})).toEqual({ status: '', lokasi: '', dari: '', sampai: '', hal: 1, per: 25 })
  })
  it('falls back for junk', () => {
    expect(bahanPageOf(-3)).toBe(1)
    expect(bahanSizeOf(9)).toBe(25)
    expect(transferStatusOf('zzz')).toBe('')
    expect(transferStatusOf('in_transit')).toBe('in_transit')
    expect(bahanLocationOf('outlet:nope')).toBe('')
    expect(bahanLocationOf(`toko:${ID}`)).toBe('')
    expect(bahanLocationOf(`outlet:${ID}:x`)).toBe('')
    expect(bahanLocationOf(`warehouse:${ID}`)).toBe(`warehouse:${ID}`)
    expect(bahanDayOf('2026-02-30')).toBe('')
    expect(bahanDayOf('abc')).toBe('')
    expect(bahanDayOf('2026-02-28')).toBe('2026-02-28')
    expect(categoryOf('x')).toBe('')
    expect(categoryOf(ID)).toBe(ID)
  })
})
