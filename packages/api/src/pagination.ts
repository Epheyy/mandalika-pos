import type { CursorListResult, ListResult } from './client'

const PAGE_SIZE = 200
/** Rows per page of a keyset export (GET /orders?paging=keyset). The offset cap stays 200. */
export const KEYSET_PAGE_SIZE = 1000
// Fail explicitly rather than issue unbounded requests for corrupt/huge metadata.
const MAX_PAGES = 10_000

/** Metadata every page must carry: a valid total, the requested limit, and an array of rows. */
function validMeta<T>(result: ListResult<T> | undefined, limit: number, page: number): { total: number } {
  const meta = result?.meta
  if (!meta || !Number.isSafeInteger(meta.total) || meta.total < 0 ||
    meta.page !== page || meta.limit !== limit || !Array.isArray(result.data)) {
    throw new Error('Data lengkap tidak tersedia: metadata halaman tidak valid. Muat ulang.')
  }
  return { total: meta.total }
}

/** Page row count and row identities (non-empty, unique across the whole read). */
function acceptRows<T extends { id: string }>(
  data: T[], expected: number, rows: T[], ids: Set<string>,
): void {
  if (data.length !== expected) {
    throw new Error('Data halaman tidak lengkap. Muat ulang untuk laporan lengkap.')
  }
  for (const row of data) {
    if (!row || typeof row.id !== 'string' || !row.id.trim() || ids.has(row.id)) {
      throw new Error('Identitas data halaman tidak konsisten. Muat ulang.')
    }
    ids.add(row.id)
    rows.push(row)
  }
}

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
    const meta = validMeta(result, PAGE_SIZE, page)
    if (total === undefined) {
      total = meta.total
      pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
      if (pages > MAX_PAGES) throw new Error('Data melebihi batas pengambilan lengkap.')
    } else if (meta.total !== total) {
      throw new Error('Data berubah saat dimuat. Muat ulang untuk laporan lengkap.')
    }
    acceptRows(result.data, Math.min(PAGE_SIZE, total - rows.length), rows, ids)
  }
  return rows
}

/** Complete ordered export over keyset pages, with checks equivalent to fetchAllPages (A26)
 * inside the snapshot the server froze at the first page: every page's total equals the first
 * page's, each page holds exactly min(limit, total - collected) rows, ids are non-empty and
 * unique, a short read of the total must come with a nextCursor, and the read stops exactly
 * at total. Any drift (a transaction committing late, a status change) fails the whole export.
 *
 * Key order is the server's guarantee (its keyset predicate, proven by Go tests); there is no
 * client-side key check because createdAt strings do not sort lexically (trimmed nanoseconds).
 *
 * `fallback` runs when page 1 shows an old backend that ignored paging=keyset (a different
 * limit, or rows missing with no cursor): the slower offset read, which has its own checks.
 */
export async function fetchAllByCursor<T extends { id: string }>(
  fetchPage: (cursor: string | undefined, limit: number) => Promise<CursorListResult<T>>,
  fallback: () => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = []
  const ids = new Set<string>()
  let total: number | undefined
  let cursor: string | undefined
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    const result = await fetchPage(cursor, KEYSET_PAGE_SIZE)
    if (total === undefined && ignoredKeyset(result)) return fallback()
    const meta = validMeta(result, KEYSET_PAGE_SIZE, 1)
    if (total === undefined) {
      total = meta.total
      if (Math.ceil(total / KEYSET_PAGE_SIZE) > MAX_PAGES) throw new Error('Data melebihi batas pengambilan lengkap.')
    } else if (meta.total !== total) {
      throw new Error('Data berubah saat dimuat. Muat ulang untuk laporan lengkap.')
    }
    acceptRows(result.data, Math.min(KEYSET_PAGE_SIZE, total - rows.length), rows, ids)
    if (rows.length === total) return rows
    const next = result.nextCursor
    if (typeof next !== 'string' || next === '' || next === cursor) {
      throw new Error('Data halaman tidak lengkap: kursor berikutnya tidak tersedia. Muat ulang.')
    }
    cursor = next
  }
  throw new Error('Data melebihi batas pengambilan lengkap.')
}

/** Page 1 of an old backend: it clamps limit=1000 to 50 and never sends a cursor. */
function ignoredKeyset<T>(result: CursorListResult<T> | undefined): boolean {
  const meta = result?.meta
  if (!meta || !Array.isArray(result.data)) return false
  if (meta.limit !== KEYSET_PAGE_SIZE) return true
  return meta.total > result.data.length && !result.nextCursor
}
