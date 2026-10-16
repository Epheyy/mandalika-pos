/**
 * Example rows for the downloadable import templates (A39). The headers are exactly the
 * columns the server importer reads (backend csvimport specs). Blank optional cells mean
 * "keep the current value" on a row that already exists; there is deliberately no stock
 * column (opening stock is loaded by goods receipt or stock count).
 */

/** Harga is a plain integer (no thousands separator); Brand is required (no default brand). */
export const PRODUCT_TEMPLATE_ROWS: Array<Record<string, string | number>> = [
  { Nama: 'Melati', Brand: 'Mandalika', Kategori: 'Floral', Deskripsi: 'Aroma melati segar', Ukuran: '50 ml', Harga: 100000, SKU: 'MEL-50', Barcode: '', Jual: 'Ya', Aktif: 'Ya', Unggulan: 'Tidak' },
  { Nama: 'Melati', Brand: 'Mandalika', Kategori: 'Floral', Deskripsi: '', Ukuran: '100 ml', Harga: 180000, SKU: 'MEL-100', Barcode: '8990000000017', Jual: 'Ya', Aktif: 'Ya', Unggulan: 'Tidak' },
]

/** Telepon: format the column as Text in Excel so the leading 0 is kept. Dates: DD/MM/YYYY or YYYY-MM-DD. */
export const CUSTOMER_TEMPLATE_ROWS: Array<Record<string, string>> = [
  { Nama: 'Ni Luh Ayu', Telepon: '081234567890', Email: 'ayu@example.com', 'Tanggal Lahir': '17/05/1990', Anniversary: '', Catatan: 'Suka aroma floral' },
  { Nama: 'Budi Santoso', Telepon: '081298765432', Email: '', 'Tanggal Lahir': '', Anniversary: '2020-01-02', Catatan: '' },
]
