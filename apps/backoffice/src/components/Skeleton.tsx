/**
 * Skeleton placeholders (pulse) used while data loads — replaces the plain
 * "Memuat…" text across backoffice list screens.
 */

function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-gray-200 ${className}`} />
}

/** Generic table/list rows placeholder. */
export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="p-4 space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="h-10 w-10 rounded-lg flex-shrink-0" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-24 hidden sm:block" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  )
}
