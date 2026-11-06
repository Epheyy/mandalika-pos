import { describe, expect, it } from 'vitest'
import { badgeFor } from './navBadgeModel'

const counts = { review: 4, approval: 2, oversell: 3, erpDead: 5 }

describe('badgeFor (D-71 colours)', () => {
  it('red for what needs a decision', () => {
    expect(badgeFor('approvals', counts)).toEqual({ count: 2, tone: 'danger', label: '2 menunggu persetujuan' })
    expect(badgeFor('syncReview', counts)).toEqual({ count: 4, tone: 'danger', label: '4 item terbuka' })
    expect(badgeFor('erpOutbox', counts)).toEqual({ count: 5, tone: 'danger', label: '5 dokumen ERP gagal' })
  })

  it('amber for what only needs a look', () => {
    expect(badgeFor('reports', counts)).toEqual({ count: 3, tone: 'warn', label: '3 stok minus belum dicek' })
  })

  it('no badge at zero or on other screens', () => {
    expect(badgeFor('syncReview', { ...counts, review: 0 })).toBeNull()
    expect(badgeFor('reports', { ...counts, oversell: 0 })).toBeNull()
    expect(badgeFor('approvals', { ...counts, approval: 0 })).toBeNull()
    expect(badgeFor('erpOutbox', { ...counts, erpDead: 0 })).toBeNull()
    expect(badgeFor('products', counts)).toBeNull()
  })
})
