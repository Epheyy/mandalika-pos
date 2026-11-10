import { describe, expect, it } from 'vitest'
import { pastEndPage } from './customersPastEnd'

describe('customers list past the end', () => {
  it('past-end page lands on the real last page', () => {
    expect(pastEndPage(99, 3, 0)).toBe(3)
    expect(pastEndPage(4, 3, 0)).toBe(3)
  })
  it('steps back one page when the previous page is the last', () => {
    expect(pastEndPage(2, 5, 0)).toBe(1)
  })
  it('an empty result set goes to page 1', () => {
    expect(pastEndPage(3, 1, 0)).toBe(1)
    expect(pastEndPage(3, 0, 0)).toBe(1)
  })
  it('leaves the first page and pages with rows alone', () => {
    expect(pastEndPage(1, 1, 0)).toBeNull()
    expect(pastEndPage(3, 5, 50)).toBeNull()
  })
})
