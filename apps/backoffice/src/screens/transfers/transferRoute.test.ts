import { describe, expect, it } from 'vitest'
import { parseHash } from '../../lib/router/hash'
import { transferHash, transferViewFromPath, type TransferView } from './transferRoute'

const view = (hash: string) => transferViewFromPath(parseHash(hash).path)

describe('transfer views in the path', () => {
  it('reads the list, the create form and a detail', () => {
    expect(view('#/inventori/transfer')).toEqual({ kind: 'list' })
    expect(view('#/inventori/transfer/baru')).toEqual({ kind: 'create' })
    expect(view('#/inventori/transfer/6f1c2e')).toEqual({ kind: 'detail', id: '6f1c2e' })
  })
  it('builds the hash for each view and reads it back', () => {
    const all: TransferView[] = [{ kind: 'list' }, { kind: 'create' }, { kind: 'detail', id: '6f1c2e' }]
    for (const v of all) expect(view(transferHash(v))).toEqual(v)
    expect(transferHash({ kind: 'detail', id: '6f1c2e' })).toBe('#/inventori/transfer/6f1c2e')
  })
})
