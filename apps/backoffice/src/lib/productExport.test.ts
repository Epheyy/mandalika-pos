import { describe, expect, it } from 'vitest'
import type { Product } from '@mandalika/api'
import { productExportRows } from './productExport'

const product = (price: number, basePrice?: number): Product =>
  ({
    id: 'p1', name: 'Melati', brand: 'Mandalika', categoryId: 'c1', description: null, sellable: true,
    isActive: true, isFeatured: false, isFavourite: false, createdAt: '2026-01-01T00:00:00Z',
    variants: [{ size: '50 ml', price, basePrice, stock: 3, sku: 'MEL-50', barcode: '' }],
  }) as unknown as Product

describe('productExportRows', () => {
  it('exports the BASE price even when an outlet override price is in scope', () => {
    const [row] = productExportRows([product(90000, 100000)], () => 'Floral')
    expect(row.Harga).toBe(100000)
  })

  it('falls back to price when the server did not send basePrice', () => {
    expect(productExportRows([product(100000)], () => '')[0].Harga).toBe(100000)
  })

  it('keeps the import layout (no stock column) and defaults barcode to the SKU', () => {
    const [row] = productExportRows([product(1, 1)], () => 'Floral')
    expect(Object.keys(row)).toEqual(['Nama', 'Brand', 'Kategori', 'Deskripsi', 'Ukuran', 'Harga', 'SKU', 'Barcode', 'Jual', 'Aktif', 'Unggulan'])
    expect(row.Barcode).toBe('MEL-50')
  })
})
