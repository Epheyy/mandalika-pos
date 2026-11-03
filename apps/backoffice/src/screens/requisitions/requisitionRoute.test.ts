import { describe, expect, it } from 'vitest'
import { parseHash } from '../../lib/router/hash'
import { requisitionHash, requisitionViewFromPath, type RequisitionView } from './requisitionRoute'

const view = (hash: string) => requisitionViewFromPath(parseHash(hash).path)

describe('requisition views in the path', () => {
  it('reads list, new, detail and edit', () => {
    expect(view('#/permintaan-barang')).toEqual({ kind: 'list' })
    expect(view('#/permintaan-barang/baru')).toEqual({ kind: 'create' })
    expect(view('#/permintaan-barang/9a8b')).toEqual({ kind: 'detail', id: '9a8b' })
    expect(view('#/permintaan-barang/9a8b/ubah')).toEqual({ kind: 'edit', id: '9a8b' })
  })
  it('treats an unknown third segment as the detail', () => {
    expect(view('#/permintaan-barang/9a8b/lain')).toEqual({ kind: 'detail', id: '9a8b' })
  })
  it('round-trips every view through its hash', () => {
    const all: RequisitionView[] = [{ kind: 'list' }, { kind: 'create' }, { kind: 'detail', id: '9a8b' }, { kind: 'edit', id: '9a8b' }]
    for (const v of all) expect(view(requisitionHash(v))).toEqual(v)
    expect(requisitionHash({ kind: 'edit', id: '9a8b' })).toBe('#/permintaan-barang/9a8b/ubah')
  })
})
