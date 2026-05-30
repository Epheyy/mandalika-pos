import { Button } from './Button'

interface PaginationProps {
  page: number
  totalPages: number
  total: number
  onChange: (page: number) => void
  className?: string
}

/**
 * Reusable pagination footer.
 *
 * NOTE: This component never auto-hides itself. Callers are responsible for
 * conditional rendering, e.g.:
 *   {totalPages > 1 && <Pagination ... />}
 * or always render it and let the disabled buttons communicate limits.
 */
export function Pagination({ page, totalPages, total, onChange, className }: PaginationProps) {
  return (
    <div className={`flex items-center justify-between${className ? ` ${className}` : ''}`}>
      <div className="flex items-center gap-2">
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
