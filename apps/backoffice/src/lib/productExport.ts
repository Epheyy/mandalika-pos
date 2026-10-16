import type { Product } from '@mandalika/api'

/**
 * Rows of the product CSV/XLSX export (also the import file layout). Harga is ALWAYS the
 * catalog BASE price: with an outlet in scope `variant.price` is that outlet's override, and
 * re-importing an override would overwrite the base price for every outlet.
 */
export function productExportRows(
  products: Product[],
  categoryName: (id: string | null | undefined) => string,
): Array<Record<string, string | number>> {
  return products.flatMap((p) =>
    p.variants.map((v) => ({
      Nama: p.name, Brand: p.brand, Kategori: categoryName(p.categoryId),
      Deskripsi: p.description || '', Ukuran: v.size, Harga: v.basePrice ?? v.price,
      SKU: v.sku, Barcode: v.barcode || v.sku,
      Jual: p.sellable === false ? 'Tidak' : 'Ya',
      Aktif: p.isActive ? 'Ya' : 'Tidak',
      Unggulan: p.isFeatured ? 'Ya' : 'Tidak',
    })),
  )
}
