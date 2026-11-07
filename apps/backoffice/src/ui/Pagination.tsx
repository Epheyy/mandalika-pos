import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from './cn'

const DEFAULT_PAGE_SIZES = [25, 50, 100]
/** Pages shown around the current one before the list collapses to "…". */
const SIBLINGS = 1

interface PaginationProps {
  page: number
  totalPages: number
  total: number
  onChange: (page: number) => void
  className?: string
  // Rows-per-page
  pageSize: number
  onPageSizeChange: (size: number) => void
  pageSizes?: number[]
}

/** The page numbers to show: first, last and the current page with its neighbours; gaps become 'gap'.
 *  Exported for tests. pageList(1, 13) = 1 2 … 13; pageList(7, 13) = 1 … 6 7 8 … 13. */
export function pageList(page: number, totalPages: number): Array<number | 'gap'> {
  const last = Math.max(1, totalPages)
  const current = Math.min(Math.max(page, 1), last)
  const wanted = new Set<number>([1, last])
  for (let p = current - SIBLINGS; p <= current + SIBLINGS; p++) if (p >= 1 && p <= last) wanted.add(p)
  const sorted = [...wanted].sort((a, b) => a - b)
  const out: Array<number | 'gap'> = []
  sorted.forEach((p, i) => {
    const prev = sorted[i - 1]
    if (prev !== undefined && p - prev === 2) out.push(prev + 1) // a one-page hole reads better as the page itself
    else if (prev !== undefined && p - prev > 2) out.push('gap')
    out.push(p)
  })
  return out
}

const NAV =
  'inline-flex h-9 min-w-9 items-center justify-center rounded-[10px] px-2 text-sm font-semibold text-ink-700 ' +
  'hover:bg-paper-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-strong ' +
  'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent'

/**
 * Reusable pagination footer: "Menampilkan 1–25 dari 312" on the left, numbered pages in the middle
 * ("‹ 1 2 3 … 13 ›", the current page is a white tile with aria-current="page"), "25 per halaman" on the right.
 *
 * NOTE: This component never auto-hides itself. Callers are responsible for
 * conditional rendering, e.g.:
 *   {totalPages > 1 && <Pagination ... />}
 * or always render it and let the disabled buttons communicate limits.
 *
 * Changing the size dropdown calls onPageSizeChange — the caller is responsible
 * for also resetting page to 1.
 */
export function Pagination({
  page,
  totalPages,
  total,
  onChange,
  className,
  pageSize,
  onPageSizeChange,
  pageSizes = DEFAULT_PAGE_SIZES,
}: PaginationProps) {
  const last = Math.max(totalPages, 1)
  const shown = Math.min(Math.max(page, 1), last)
  const from = total === 0 ? 0 : Math.min((shown - 1) * pageSize + 1, total)
  const to = Math.min(total, shown * pageSize)
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-3', className)}>
      <span aria-live="polite" className="text-[13px] tabular-nums text-ink-700">
        {total > 0 ? `Menampilkan ${from}–${to} dari ${total}` : 'Tidak ada data'}
      </span>
      <nav aria-label="Halaman" className="flex items-center gap-1">
        <button type="button" aria-label="Sebelumnya" className={NAV} onClick={() => onChange(Math.max(1, shown - 1))} disabled={shown <= 1}>
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </button>
        {pageList(shown, last).map((p, i) =>
          p === 'gap' ? (
            <span key={`gap-${i}`} aria-hidden="true" className="inline-flex h-9 min-w-9 items-center justify-center text-sm text-ink-500">
              …
            </span>
          ) : (
            <button
              key={p}
              type="button"
              aria-label={`Halaman ${p}`}
              aria-current={p === shown ? 'page' : undefined}
              onClick={() => onChange(p)}
              className={cn(
                NAV,
                'tabular-nums',
                p === shown && 'bg-white text-brand-strong shadow-[0_0_0_0.5px_rgba(26,16,8,0.08),0_3px_10px_-2px_rgba(70,46,10,0.18)] hover:bg-white',
              )}
            >
              {p}
            </button>
          ),
        )}
        <button type="button" aria-label="Berikutnya" className={NAV} onClick={() => onChange(Math.min(last, shown + 1))} disabled={shown >= last}>
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </nav>
      <select
        aria-label="Baris per halaman"
        value={pageSize}
        onChange={(e) => onPageSizeChange(Number(e.target.value))}
        className="h-9 rounded-[10px] border border-paper-2 bg-white px-2 text-[13px] font-semibold text-ink-700 focus:outline-none focus:ring-2 focus:ring-brand-strong/40"
      >
        {pageSizes.map((s) => (
          <option key={s} value={s}>
            {s} per halaman
          </option>
        ))}
      </select>
    </div>
  )
}
