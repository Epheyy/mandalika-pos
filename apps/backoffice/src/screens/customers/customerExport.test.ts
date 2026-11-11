import { describe, expect, it } from 'vitest'
import type { Customer } from '@mandalika/api'
import { createdAtKey, customerExportRows, describeCustomerFilters, exportPageSort, sortBySpend } from './customerExport'

const cust = (id: string, totalSpent: number, createdAt: string): Customer =>
  ({ id, name: id, phone: '', points: 0, totalSpent, visitCount: 0, createdAt }) as Customer

describe('exportPageSort', () => {
  it('pages the spend sort by creation order and leaves terbaru alone', () => {
    expect(exportPageSort('belanja')).toBe('terbaru')
    expect(exportPageSort('terbaru')).toBe('terbaru')
  })
})

describe('createdAtKey', () => {
  it('keeps microseconds and any offset', () => {
    expect(createdAtKey('2026-01-01T00:00:00.000001Z')[1]).toBe(1)
    expect(createdAtKey('2026-01-01T00:00:00.123456Z')).toEqual([Date.parse('2026-01-01T00:00:00.123Z'), 456])
    expect(createdAtKey('2026-01-01T07:00:00+07:00')).toEqual(createdAtKey('2026-01-01T00:00:00Z'))
    expect(createdAtKey('2026-01-01T00:00:00.123456789Z')).toEqual([Date.parse('2026-01-01T00:00:00.123Z'), 456])
  })
})

describe('sortBySpend', () => {
  it('orders by spend, highest first', () => {
    const out = sortBySpend([cust('a', 1, '2026-01-01T00:00:00Z'), cust('b', 9, '2026-01-01T00:00:00Z'), cust('c', 5, '2026-01-01T00:00:00Z')])
    expect(out.map((c) => c.id)).toEqual(['b', 'c', 'a'])
  })
  it('breaks spend ties by createdAt at microsecond precision, newest first', () => {
    const out = sortBySpend([cust('a', 5, '2026-01-01T00:00:00Z'), cust('b', 5, '2026-01-01T00:00:00.000001Z')])
    expect(out.map((c) => c.id)).toEqual(['b', 'a'])
  })
  it('compares mixed offsets as instants', () => {
    const out = sortBySpend([cust('a', 5, '2026-01-01T00:30:00Z'), cust('b', 5, '2026-01-01T07:00:00+07:00')])
    expect(out.map((c) => c.id)).toEqual(['a', 'b'])
    const out2 = sortBySpend([cust('a', 5, '2026-01-01T00:30:00Z'), cust('b', 5, '2026-01-01T08:00:00+07:00')])
    expect(out2.map((c) => c.id)).toEqual(['b', 'a'])
  })
  it('breaks full ties by id, descending', () => {
    const at = '2026-01-01T00:00:00Z'
    const out = sortBySpend([cust('0000-a', 5, at), cust('0000-c', 5, at), cust('0000-B', 5, at)])
    expect(out.map((c) => c.id)).toEqual(['0000-c', '0000-B', '0000-a'])
  })
  it('does not mutate its input', () => {
    const input = [cust('a', 1, '2026-01-01T00:00:00Z'), cust('b', 2, '2026-01-01T00:00:00Z')]
    const copy = [...input]
    sortBySpend(input)
    expect(input).toEqual(copy)
  })
})

const none = () => undefined

describe('describeCustomerFilters', () => {
  it('is empty for the default list', () => {
    expect(describeCustomerFilters({ q: ' ', sort: 'belanja', tagId: '', segmentId: '' }, none, none)).toEqual([])
  })

  it('names every narrowing filter, falling back for an unknown id', () => {
    const out = describeCustomerFilters({ q: 'sari', sort: 'terbaru', tagId: 't1', segmentId: 's9' }, (id) => (id === 't1' ? 'VIP' : undefined), none)
    expect(out).toEqual(['Cari: sari', 'Tag: VIP', 'Segmen: tidak dikenal', 'Urutan: Terbaru'])
  })
})

describe('customerExportRows', () => {
  it('keeps the export columns and joins tags', () => {
    const c = { name: 'A', phone: '1', email: null, points: 5, totalSpent: 10, visitCount: 2, tags: [{ id: 'a', name: 'VIP' }, { id: 'b', name: 'Baru' }], segment: { name: 'Gold' } } as unknown as Customer
    expect(customerExportRows([c])).toEqual([
      { Nama: 'A', Telepon: '1', Email: '', Poin: 5, 'Total Belanja': 10, 'Jumlah Kunjungan': 2, Tag: 'VIP, Baru', Segmen: 'Gold' },
    ])
  })
})
