import { Button } from './Button'

const DEFAULT_PAGE_SIZES = [25, 50, 100]

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

/**
 * Reusable pagination footer.
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
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(total, page * pageSize)
  return (
    <div className={`flex flex-wrap items-center justify-between gap-3${className ? ` ${className}` : ''}`}>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-[13px] text-ink-700">
          Baris:
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            className="h-9 rounded-lg border border-paper-2 bg-white px-2 text-[13px] font-bold text-ink-700 focus:outline-none focus:ring-2 focus:ring-brand-strong/40"
          >
            {pageSizes.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <span className="text-[13px] tabular-nums text-ink-700">Hal {page}/{totalPages}</span>
        {total > 0 && (
          <span className="text-[13px] tabular-nums text-ink-500">
            Menampilkan {from}–{to} dari {total} catatan
          </span>
        )}
      </div>
      <div className="flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onChange(Math.max(1, page - 1))}
          disabled={page <= 1}
        >
          ‹ Sebelumnya
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onChange(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
        >
          Berikutnya ›
        </Button>
      </div>
    </div>
  )
}
