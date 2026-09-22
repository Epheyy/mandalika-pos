import type { ListResult } from './client'

const PAGE_SIZE = 200
// Fail explicitly rather than issue unbounded requests for corrupt/huge metadata.
const MAX_PAGES = 10_000

/** Complete ordered list or rejection; never exposes an incomplete prefix.
 * Offset pagination is not a snapshot: detectable drift fails the whole read.
 */
export async function fetchAllPages<T extends { id: string }>(
  fetchPage: (page: number, limit: number) => Promise<ListResult<T>>,
): Promise<T[]> {
  const rows: T[] = []
  const ids = new Set<string>()
  let total: number | undefined
  let pages = 1
  for (let page = 1; page <= pages; page++) {
    const result = await fetchPage(page, PAGE_SIZE)
    const meta = result?.meta
    if (!meta || !Number.isSafeInteger(meta.total) || meta.total < 0 ||
      meta.page !== page || meta.limit !== PAGE_SIZE || !Array.isArray(result.data)) {
      throw new Error('Data lengkap tidak tersedia: metadata halaman tidak valid. Muat ulang.')
    }
    if (total === undefined) {
      total = meta.total
      pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
      if (pages > MAX_PAGES) throw new Error('Data melebihi batas pengambilan lengkap.')
    } else if (meta.total !== total) {
      throw new Error('Data berubah saat dimuat. Muat ulang untuk laporan lengkap.')
    }
    if (result.data.length !== Math.min(PAGE_SIZE, total - rows.length)) {
      throw new Error('Data halaman tidak lengkap. Muat ulang untuk laporan lengkap.')
    }
    for (const row of result.data) {
      if (!row || typeof row.id !== 'string' || !row.id.trim() || ids.has(row.id)) {
        throw new Error('Identitas data halaman tidak konsisten. Muat ulang.')
      }
      ids.add(row.id)
      rows.push(row)
    }
  }
  return rows
}
