import { describe, expect, it } from 'vitest'
import { parseListState } from '../../lib/router/useListState'
import {
  OVERVIEW_SCHEMA,
  kindFilterCode,
  kindFilterOf,
  locationFromPath,
  locationHash,
  overviewPageOf,
  overviewSizeOf,
} from './overviewRoute'

const ID = '00000000-0000-4000-8f6b-0000000000a1'
const STOK = ['inventori', 'stok']
const BAHAN = ['inventori', 'bahan']

describe('locationFromPath', () => {
  it('reads outlet and gudang under the product Ikhtisar', () => {
    expect(locationFromPath(['inventori', 'stok', 'lokasi', 'outlet', ID], STOK)).toEqual({ kind: 'outlet', id: ID })
    expect(locationFromPath(['inventori', 'stok', 'lokasi', 'gudang', ID], STOK)).toEqual({ kind: 'warehouse', id: ID })
  })
  it('reads the Bahan form with the ikhtisar tab in front', () => {
    expect(locationFromPath(['inventori', 'bahan', 'ikhtisar', 'lokasi', 'gudang', ID], BAHAN, 1)).toEqual({ kind: 'warehouse', id: ID })
    expect(locationFromPath(['inventori', 'bahan', 'daftar', 'lokasi', 'gudang', ID], BAHAN, 1)).toBeNull()
  })
  it('is null for anything else', () => {
    expect(locationFromPath(['inventori', 'stok'], STOK)).toBeNull()
    expect(locationFromPath(['inventori', 'stok', 'lokasi', 'toko', ID], STOK)).toBeNull()
    expect(locationFromPath(['inventori', 'stok', 'lokasi', 'outlet', '../x'], STOK)).toBeNull()
    expect(locationFromPath(['inventori', 'transfer', 'lokasi', 'outlet', ID], STOK)).toBeNull()
  })
  it('builds the matching hash', () => {
    expect(locationHash(STOK, { kind: 'warehouse', id: ID })).toBe(`#/inventori/stok/lokasi/gudang/${ID}`)
    expect(locationHash([...BAHAN, 'ikhtisar'], { kind: 'outlet', id: ID })).toBe(`#/inventori/bahan/ikhtisar/lokasi/outlet/${ID}`)
  })
})

describe('matrix filters', () => {
  it('maps the URL code of the kind filter both ways and falls back to outlets', () => {
    expect(kindFilterOf('gudang')).toBe('warehouse')
    expect(kindFilterOf('semua')).toBe('semua')
    expect(kindFilterOf('zzz')).toBe('outlet')
    expect(kindFilterCode('warehouse')).toBe('gudang')
    expect(kindFilterCode('outlet')).toBe('outlet')
  })
  it('clamps page and page size', () => {
    expect(overviewPageOf(-1)).toBe(1)
    expect(overviewPageOf(3)).toBe(3)
    expect(overviewSizeOf(7)).toBe(25)
    expect(overviewSizeOf(50)).toBe(50)
  })
  it('keeps defaults implicit', () => {
    expect(parseListState(OVERVIEW_SCHEMA, {})).toEqual({ q: '', jenis: 'outlet', hal: 1, per: 25 })
  })
})
