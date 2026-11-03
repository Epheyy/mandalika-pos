import { describe, expect, it } from 'vitest'
import { buildHash } from '../../lib/router/hash'
import { parseListState, serializeListState } from '../../lib/router/useListState'
import { DASHBOARD_SCHEMA, periodFromSlug, periodSlug } from './periodRoute'

describe('periodRoute', () => {
  it('round-trips every period', () => {
    for (const p of ['today', '7d', '30d', 'all'] as const) expect(periodFromSlug(periodSlug(p))).toBe(p)
  })
  it('falls back to 7 hari for junk', () => {
    expect(periodFromSlug('zzz')).toBe('7d')
    expect(periodFromSlug('')).toBe('7d')
  })
  it('keeps the default out of the URL', () => {
    const state = parseListState(DASHBOARD_SCHEMA, {})
    expect(buildHash(['ringkasan'], serializeListState(DASHBOARD_SCHEMA, state))).toBe('#/ringkasan')
    expect(buildHash(['ringkasan'], serializeListState(DASHBOARD_SCHEMA, { periode: '30h' }))).toBe('#/ringkasan?periode=30h')
  })
})
