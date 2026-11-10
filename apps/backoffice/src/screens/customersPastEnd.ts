/**
 * Where a customers list that answered an empty page past the end should go: the real last
 * page (the server now reports the true total for a page past the end), never beyond the
 * previous page. null = the page is fine (first page, or it has rows).
 */
export function pastEndPage(page: number, totalPages: number, rowCount: number): number | null {
  if (page <= 1 || rowCount > 0) return null
  return Math.min(page - 1, Math.max(1, totalPages))
}
