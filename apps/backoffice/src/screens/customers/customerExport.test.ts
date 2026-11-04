import { describe, expect, it } from 'vitest'
import type { Customer } from '@mandalika/api'
import { customerExportRows, describeCustomerFilters } from './customerExport'

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
