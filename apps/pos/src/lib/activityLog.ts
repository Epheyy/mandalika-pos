/**
 * Lightweight in-memory activity breadcrumb trail. `track()` is sprinkled at key
 * cashier actions; on an error we attach the last ~20 crumbs so support can see
 * what the user did leading up to it. Memory-only (not persisted) — it's just
 * context for an error report.
 */

export interface Breadcrumb {
  at: string
  label: string
}

const MAX = 20
let crumbs: Breadcrumb[] = []

export function track(label: string): void {
  crumbs.push({ at: new Date().toISOString(), label })
  if (crumbs.length > MAX) crumbs = crumbs.slice(-MAX)
}

export function getBreadcrumbs(): Breadcrumb[] {
  return crumbs.slice()
}
