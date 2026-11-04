import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Api } from '@mandalika/api'
import { catalogueSignal, withCatalogueSignal } from '../api'

const base = (over: Partial<Record<keyof Api, unknown>> = {}) =>
  ({
    createProduct: vi.fn(async () => ({ id: 'p1' })),
    updateProduct: vi.fn(async () => ({ id: 'p1' })),
    importCsv: vi.fn(async () => ({})),
    listProducts: vi.fn(async () => ({ data: [], meta: { total: 0, page: 1, limit: 200 } })),
    ...over,
  }) as unknown as Api

afterEach(() => {
  catalogueSignal.onChanged = null
})

describe('withCatalogueSignal', () => {
  it('signals after a product write settles, returning the write result', async () => {
    const signal = vi.fn()
    catalogueSignal.onChanged = signal
    const api = withCatalogueSignal(base())
    expect(await api.createProduct({} as never)).toEqual({ id: 'p1' })
    expect(signal).toHaveBeenCalledTimes(1)
  })

  it('signals even when the write fails (it may have half applied) and rethrows', async () => {
    const signal = vi.fn()
    catalogueSignal.onChanged = signal
    const api = withCatalogueSignal(base({ updateProduct: vi.fn(async () => { throw new Error('503') }) }))
    await expect(api.updateProduct('p1', {} as never)).rejects.toThrow('503')
    expect(signal).toHaveBeenCalledTimes(1)
  })

  it('does not signal for reads or for an import preview (dry run), but does for an applied import', async () => {
    const signal = vi.fn()
    catalogueSignal.onChanged = signal
    const api = withCatalogueSignal(base())
    await api.listProducts()
    await api.importCsv('products', { csv: 'a', fileName: 'a.csv', dryRun: true })
    expect(signal).not.toHaveBeenCalled()
    await api.importCsv('products', { csv: 'a', fileName: 'a.csv', dryRun: false })
    expect(signal).toHaveBeenCalledTimes(1)
  })
})
