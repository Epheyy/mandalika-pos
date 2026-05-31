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
  return (
    <div className={`flex items-center justify-between${className ? ` ${className}` : ''}`}>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-gray-500">
          Baris:
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            className="text-xs font-bold rounded-lg border border-gray-200 px-2 py-1 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-gold-500/40 focus:border-gold-400 transition"
          >
            {pageSizes.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <span className="text-xs text-gray-500">Hal {page}/{totalPages}</span>
        {total > 0 && (
          <span className="text-xs text-gray-400">{total} catatan</span>
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
