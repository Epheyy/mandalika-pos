/**
 * Skeleton placeholders (pulse) used while data loads — replaces the plain
 * "Memuat…" text and spinners across the POS.
 */

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-gray-200 ${className}`} />
}

/** Product grid placeholder cards. */
function ProductGridSkeleton({ cols = 4, count = 8 }: { cols?: number; count?: number }) {
  const colClass =
    cols === 2 ? 'grid-cols-2' : cols === 3 ? 'grid-cols-3' : cols === 6 ? 'grid-cols-6' : 'grid-cols-4'
  return (
    <div className={`grid ${colClass} gap-3 p-3`}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-xl border border-gray-100 p-3 space-y-2">
          <Skeleton className="aspect-square w-full rounded-lg" />
          <Skeleton className="h-3 w-3/4" />
        </div>
      ))}
    </div>
  )
}

/** Generic list rows (transaction history, etc.). */
export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center justify-between border border-gray-100 rounded-xl px-3 py-2.5">
          <div className="space-y-1.5 flex-1">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-2.5 w-2/3" />
          </div>
          <Skeleton className="h-4 w-16 flex-shrink-0 ml-2" />
        </div>
      ))}
    </div>
  )
}

/** Full cashier-shell placeholder shown while the first snapshot loads. */
export function AppLoadingSkeleton() {
  return (
    <div className="h-screen flex flex-col bg-gray-50 overflow-hidden">
      <div className="bg-white border-b border-gray-100 px-3 py-2 flex items-center justify-between safe-top">
        <div className="flex items-center gap-3">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-4 w-20" />
        </div>
        <Skeleton className="h-8 w-8 rounded-lg" />
      </div>
      <div className="px-4 py-3 space-y-2">
        <Skeleton className="h-10 w-full rounded-xl" />
        <Skeleton className="h-10 w-full rounded-xl" />
      </div>
      <div className="flex-1 overflow-hidden">
        <ProductGridSkeleton />
      </div>
    </div>
  )
}
