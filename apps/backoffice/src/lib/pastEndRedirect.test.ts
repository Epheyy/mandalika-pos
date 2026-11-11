import { describe, expect, it } from 'vitest'
import { pastEndRedirect } from './pastEndRedirect'

const answered = (page: number) => ({ loading: false, data: { meta: { page } } })

describe('pastEndRedirect', () => {
  it('sends an empty page above 1 to min(page - 1, totalPages)', () => {
    expect(pastEndRedirect(answered(9), 9, 0, 3)).toBe(3)
    expect(pastEndRedirect(answered(4), 4, 0, 10)).toBe(3)
    expect(pastEndRedirect(answered(3), 3, 0, 0)).toBe(1)
  })

  it('stays on page 1 even when empty', () => {
    expect(pastEndRedirect(answered(1), 1, 0, 1)).toBeNull()
  })

  it('stays on a page that has rows', () => {
    expect(pastEndRedirect(answered(3), 3, 25, 5)).toBeNull()
  })

  it('ignores an answer to another page, a loading query and no data yet', () => {
    expect(pastEndRedirect(answered(2), 5, 0, 3)).toBeNull()
    expect(pastEndRedirect({ loading: true, data: { meta: { page: 5 } } }, 5, 0, 3)).toBeNull()
    expect(pastEndRedirect({ loading: false, data: null }, 5, 0, 3)).toBeNull()
    expect(pastEndRedirect({ loading: false, data: { meta: {} } }, 5, 0, 3)).toBeNull()
  })
})
