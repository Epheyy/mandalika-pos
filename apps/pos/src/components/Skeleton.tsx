/**
 * Skeleton placeholders (pulse) used while data loads — replaces the plain
 * "Memuat…" text and spinners across the POS.
 */

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-paper-2 ${className}`} />
}

// 4 columns is the 1280 dp design (180 dp tiles beside the 486 dp cart); narrower widths step down so a tile never gets thinner than its photo and name need.
export const PRODUCT_GRID_COLS: Record<number, string> = {
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4',
  6: 'grid-cols-3 sm:grid-cols-4 lg:grid-cols-6',
}

/** Product tile placeholder: the real tile's shape (150 dp, 56 dp photo, two name lines, price, stock). */
function ProductTileSkeleton() {
  return (
    <div className="surface-card flex min-h-[150px] flex-col gap-2 rounded-control p-3" aria-hidden="true">
      <div className="flex items-start gap-2">
        <Skeleton className="h-14 w-14 flex-shrink-0 rounded-lg" />
        <div className="min-w-0 flex-1 space-y-1.5 pt-0.5">
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-2/3" />
        </div>
      </div>
      <div className="mt-auto space-y-1.5">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-3 w-1/3" />
      </div>
    </div>
  )
}

/** Product grid placeholder: same column classes and gap as the real grid. */
export function ProductGridSkeleton({ className = PRODUCT_GRID_COLS[4], count = 8 }: { className?: string; count?: number }) {
  return (
    <div className={`grid ${className} gap-2`}>
      {Array.from({ length: count }).map((_, i) => (
        <ProductTileSkeleton key={i} />
      ))}
    </div>
  )
}

/** Generic list rows (transaction history, etc.). */
export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="surface-card flex items-center justify-between rounded-control px-3 py-2.5">
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
    <div className="h-screen flex flex-col bg-paper-0 overflow-hidden">
      <div className="surface-glass px-3 py-2 flex items-center justify-between safe-top">
        <div className="flex items-center gap-3">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-4 w-20" />
        </div>
        <Skeleton className="h-8 w-8 rounded-lg" />
      </div>
      <div className="px-4 py-3 space-y-2">
        <Skeleton className="h-12 w-full rounded-control" />
        <Skeleton className="h-11 w-full rounded-chip" />
      </div>
      <div className="flex-1 overflow-hidden px-3">
        <ProductGridSkeleton />
      </div>
    </div>
  )
}
