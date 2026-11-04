import { describe, expect, it } from 'vitest'
import { parseHash } from '../../lib/router/hash'
import {
  REQUISITION_LIST_SCHEMA,
  isRequisitionListPath,
  requisitionHash,
  requisitionPageOf,
  requisitionSizeOf,
  requisitionStatusOf,
  requisitionViewFromPath,
  type RequisitionView,
} from './requisitionRoute'

const view = (hash: string) => requisitionViewFromPath(parseHash(hash).path)

describe('requisition views in the path', () => {
  it('reads list, new, detail and edit', () => {
    expect(view('#/permintaan-barang')).toEqual({ kind: 'list' })
    expect(view('#/permintaan-barang/baru')).toEqual({ kind: 'create' })
    expect(view('#/permintaan-barang/9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d')).toEqual({ kind: 'detail', id: '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d' })
    expect(view('#/permintaan-barang/9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d/ubah')).toEqual({ kind: 'edit', id: '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d' })
  })
  it('treats an id that is not a uuid as the list (ids reach API URLs)', () => {
    expect(view('#/permintaan-barang/..%2F..%2Fauth%2Fme')).toEqual({ kind: 'list' })
    expect(view('#/permintaan-barang/..%2Fx/ubah')).toEqual({ kind: 'list' })
  })
  it('treats an unknown third segment as the detail', () => {
    expect(view('#/permintaan-barang/9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d/lain')).toEqual({ kind: 'detail', id: '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d' })
  })
  it('round-trips every view through its hash', () => {
    const all: RequisitionView[] = [{ kind: 'list' }, { kind: 'create' }, { kind: 'detail', id: '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d' }, { kind: 'edit', id: '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d' }]
    for (const v of all) expect(view(requisitionHash(v))).toEqual(v)
    expect(requisitionHash({ kind: 'edit', id: '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d' })).toBe('#/permintaan-barang/9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d/ubah')
  })
})

describe('requisition list filters', () => {
  it('reads only known statuses, pages and page sizes', () => {
    expect(requisitionStatusOf('approved')).toBe('approved')
    expect(requisitionStatusOf('zzz')).toBe('')
    expect(requisitionPageOf(-3)).toBe(1)
    expect(requisitionPageOf(4.7)).toBe(4)
    expect(requisitionSizeOf(50)).toBe(50)
    expect(requisitionSizeOf(7)).toBe(25)
  })
  it('keeps defaults out of the URL schema', () => {
    expect(REQUISITION_LIST_SCHEMA.status.default).toBe('')
    expect(REQUISITION_LIST_SCHEMA.per.default).toBe(25)
  })
  it('a list path is the list whatever its filters (they are query, not path)', () => {
    expect(isRequisitionListPath(parseHash('#/permintaan-barang?status=draft').path)).toBe(true)
    expect(isRequisitionListPath(parseHash('#/permintaan-barang/baru').path)).toBe(false)
  })
})
