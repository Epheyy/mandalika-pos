import { memo, useCallback, useEffect, useMemo, useState, type CSSProperties, type MutableRefObject } from 'react'
import type { components } from '@mandalika/api'
import {
  DndContext,
  closestCenter,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  rectSortingStrategy,
  arrayMove,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { formatRupiah } from './pricing'
import { nextVariantQty, oversoldSizes } from './stock'
import { variantLabel } from '@mandalika/types'
import { IconHeart, IconScan } from '../components/ui/icons'
import { Chip } from '../components/ui/Chip'
import { Sheet } from '../components/ui/Sheet'
import { Stepper } from '../components/ui/Stepper'
import { STOCK_DOT_CLASS, STOCK_TEXT_CLASS, stockLabel, stockTone, type StockTone } from './stockTone'

type Product = components['schemas']['Product']
type Category = components['schemas']['Category']

const ORDER_KEY = 'pos_productOrder'

function loadOrder(): string[] {
  try {
    const raw = localStorage.getItem(ORDER_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

/** Sort products by the cashier's saved custom order; unranked keep their
 *  original (server) order at the end. Stable. */
function sortByCustomOrder(products: Product[], order: string[]): Product[] {
  if (order.length === 0) return products
  const rank = new Map(order.map((id, i) => [id, i]))
  return products
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const ra = rank.get(a.p.id) ?? Infinity
      const rb = rank.get(b.p.id) ?? Infinity
      return ra === rb ? a.i - b.i : ra - rb
    })
    .map((x) => x.p)
}

interface ProductGridProps {
  products: Product[]
  categories: Category[]
  selectedCategoryId: string | null
  searchQuery: string
  showFavouritesOnly: boolean
  gridCols: 2 | 3 | 4 | 6
  showPrice: boolean
  showStock: boolean
  showVariants: boolean
  onProductTap: (product: Product, variantQtys: Record<string, number>) => void
  onCategoryChange: (id: string | null) => void
  onSearchChange: (q: string) => void
  onSearchSubmit?: (q: string) => void
  onScanClick?: () => void
  onToggleFavourites: () => void
  isLoading: boolean
  /** Filled while the variant sheet is open so the screen's Android Back handler can close it (returns true when it did). */
  variantBackRef?: MutableRefObject<(() => boolean) | null>
}

interface SortableCardProps {
  product: Product
  gridCols: number
  categoryName: string | undefined
  showPrice: boolean
  showStock: boolean
  showVariants: boolean
  onTap: (product: Product) => void
}

/** Bottle silhouette for products without a photo. Decorative; the name sits next to it. */
function BottlePlaceholder() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 2.5h4v3h-4z" />
      <path d="M9 5.5h6v2l2 2.5v9.5a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V10l2-2.5z" />
      <path d="M9.5 14h5" />
    </svg>
  )
}

// Narrow tiles (under about 150 dp) stack the photo above the name so the name keeps room. Keyed on the column count per breakpoint, not on measured width.
const HEAD_LAYOUT: Record<number, { head: string; photo: string }> = {
  2: { head: 'flex-row', photo: 'h-14 w-14' },
  3: { head: 'flex-col lg:flex-row', photo: 'h-10 w-10 lg:h-14 lg:w-14' },
  4: { head: 'flex-row sm:flex-col xl:flex-row', photo: 'h-14 w-14 sm:h-10 sm:w-10 xl:h-14 xl:w-14' },
  6: { head: 'flex-col', photo: 'h-10 w-10' },
}

/** Colour dot + stock word on a tile. Never colour alone. */
function StockLine({ tone, text, soldOutSizes = 0 }: { tone: StockTone; text: string; soldOutSizes?: number }) {
  return (
    <p className={`flex items-center gap-1.5 text-[0.8125rem] font-semibold ${STOCK_TEXT_CLASS[tone]}`}>
      <span aria-hidden="true" className={`h-2 w-2 flex-shrink-0 rounded-full ${STOCK_DOT_CLASS[tone]}`} />
      {text}
      {soldOutSizes > 0 && <span className="text-warn">{` · ${soldOutSizes} ukuran habis`}</span>}
    </p>
  )
}

const SortableCard = memo(function SortableCard({ product, gridCols, categoryName, showPrice, showStock, showVariants, onTap }: SortableCardProps) {
  const totalStock = product.variants.reduce((s, v) => s + v.stock, 0)
  const inStock = totalStock > 0
  const prices = product.variants.map((v) => v.price)
  const minPrice = prices.length ? Math.min(...prices) : 0
  const maxPrice = prices.length ? Math.max(...prices) : 0
  // Compact price for small grids: a single price, or the minimum with "+"
  // when variants differ (e.g. "Rp 250.000+").
  const priceLabel = minPrice === maxPrice ? formatRupiah(minPrice) : `${formatRupiah(minPrice)}+`
  const subline = categoryName ?? ''
  const tone = stockTone(totalStock)
  const layout = HEAD_LAYOUT[gridCols] ?? HEAD_LAYOUT[4]
  const [imgFailed, setImgFailed] = useState(false)
  const soldOutSizes = product.variants.length > 1 && inStock ? product.variants.filter((v) => v.stock <= 0).length : 0
  // "Habis" / negative stock always shows, even when the stock display is off; the toggle only hides the positive count.
  const showStockRow = showStock || !inStock

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: product.id })

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
    zIndex: isDragging ? 20 : undefined,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      // A44 owner decision 2026-10-16: an out-of-stock item is still sellable. The card
      // keeps a clear "Habis" warning and the add is warned + recorded server-side.
      onClick={() => onTap(product)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onTap(product)
        }
      }}
      className={`flex min-h-[150px] cursor-pointer select-none touch-manipulation flex-col gap-2 rounded-control border bg-white p-3 text-left active:scale-[0.98] ${
        inStock ? 'border-paper-2' : 'border-danger'
      } ${isDragging ? 'shadow-lg ring-2 ring-paper-2' : 'transition-transform duration-150'}`}
    >
      <div className={`flex items-start gap-2 ${layout.head}`}>
        {product.imageUrl && !imgFailed ? (
          <img
            src={product.imageUrl}
            alt=""
            onError={() => setImgFailed(true)}
            className={`pointer-events-none flex-shrink-0 rounded-lg object-cover ${layout.photo} ${inStock ? '' : 'grayscale opacity-60'}`}
            loading="lazy"
            draggable={false}
          />
        ) : (
          <div className={`flex flex-shrink-0 items-center justify-center rounded-lg bg-paper-1 text-ink-500 ${layout.photo} ${inStock ? '' : 'opacity-60'}`}>
            <BottlePlaceholder />
          </div>
        )}
        <div className="w-full min-w-0 flex-1">
          <p className="line-clamp-2 text-[0.9375rem] font-semibold leading-snug text-ink-900">{product.name}</p>
          {subline && <p className="mt-0.5 truncate text-xs text-ink-500">{subline}</p>}
        </div>
      </div>

      {showVariants ? (
        /* Per-variant rows — each variant's own price/stock, not an
           accumulated total. */
        <div className="mt-auto space-y-1">
          {product.variants.map((v) => (
            <div key={v.size} className="flex items-baseline justify-between gap-2 text-xs">
              {variantLabel(v.size) && <span className="truncate text-ink-700">{variantLabel(v.size)}</span>}
              {(showPrice || showStock) && (
                <span className="flex flex-shrink-0 items-center gap-2">
                  {showPrice && <span className="tnum font-bold text-ink-900">{formatRupiah(v.price)}</span>}
                  {showStock && <span className={`tnum font-semibold ${STOCK_TEXT_CLASS[stockTone(v.stock)]}`}>{stockLabel(v.stock)}</span>}
                </span>
              )}
            </div>
          ))}
          {!showStock && !inStock && <StockLine tone={tone} text={stockLabel(totalStock)} />}
        </div>
      ) : (
        <div className="mt-auto space-y-1">
          {(showPrice || product.variants.length > 1) && (
            <div className="flex items-baseline justify-between gap-2">
              {showPrice && <p className="tnum truncate text-base font-bold text-ink-900">{priceLabel}</p>}
              {product.variants.length > 1 && (
                <p className="ml-auto flex-shrink-0 text-xs text-ink-500">{product.variants.length} ukuran</p>
              )}
            </div>
          )}
          {showStockRow && <StockLine tone={tone} text={stockLabel(totalStock)} soldOutSizes={showStock ? soldOutSizes : 0} />}
        </div>
      )}
    </div>
  )
})

// 4 columns is the 1280 dp design (180 dp tiles beside the 486 dp cart); narrower widths step down so a tile never gets thinner than its photo and name need.
const colClass: Record<number, string> = {
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4',
  6: 'grid-cols-3 sm:grid-cols-4 lg:grid-cols-6',
}

export const ProductGrid = memo(function ProductGrid({
  products,
  categories,
  selectedCategoryId,
  searchQuery,
  showFavouritesOnly,
  gridCols,
  showPrice,
  showStock,
  showVariants,
  onProductTap,
  onCategoryChange,
  onSearchChange,
  onSearchSubmit,
  onScanClick,
  onToggleFavourites,
  isLoading,
  variantBackRef,
}: ProductGridProps) {
  const [variantPopup, setVariantPopup] = useState<Product | null>(null)
  const [variantQtys, setVariantQtys] = useState<Record<string, number>>({})
  const [order, setOrder] = useState<string[]>(loadOrder)

  // Android Back closes the variant sheet before anything underneath.
  useEffect(() => {
    if (!variantBackRef) return
    variantBackRef.current = variantPopup ? () => { setVariantPopup(null); return true } : null
    return () => { variantBackRef.current = null }
  }, [variantPopup, variantBackRef])

  const categoryNames = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories])

  // Custom order applied first, then the category/search/favourite filters.
  const orderedAll = useMemo(() => sortByCustomOrder(products, order), [products, order])
  const filtered = orderedAll.filter((p) => {
    const matchSearch = p.name.toLowerCase().includes(searchQuery.toLowerCase())
    const matchCat = !selectedCategoryId || p.categoryId === selectedCategoryId
    const matchFav = !showFavouritesOnly || p.isFavourite
    return matchSearch && matchCat && matchFav
  })

  // Mouse: drag after 8px. Touch: press-and-hold 200ms (so a tap adds to cart
  // and a swipe scrolls the grid; only a deliberate hold starts a reorder).
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  )

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const ids = orderedAll.map((p) => p.id)
    const oldIndex = ids.indexOf(String(active.id))
    const newIndex = ids.indexOf(String(over.id))
    if (oldIndex < 0 || newIndex < 0) return
    const next = arrayMove(ids, oldIndex, newIndex)
    setOrder(next)
    try {
      localStorage.setItem(ORDER_KEY, JSON.stringify(next))
    } catch {
      /* quota — order just won't persist this session */
    }
  }

  const handleProductClick = useCallback((product: Product) => {
    if (product.variants.length === 1) {
      onProductTap(product, { [product.variants[0].size]: 1 })
      return
    }
    const qtys: Record<string, number> = {}
    product.variants.forEach((v) => { qtys[v.size] = 0 })
    setVariantQtys(qtys)
    setVariantPopup(product)
  }, [onProductTap])

  const handleVariantChange = (size: string, delta: number) => {
    if (!variantPopup) return
    if (!variantPopup.variants.some((v) => v.size === size)) return
    // Not capped by stock (A44 owner decision 2026-10-16); the popup warns instead.
    setVariantQtys((prev) => ({ ...prev, [size]: nextVariantQty(prev[size] || 0, delta) }))
  }

  const handleConfirmVariants = () => {
    if (!variantPopup) return
    onProductTap(variantPopup, variantQtys)
    setVariantPopup(null)
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-paper-0">
      {/* Search bar — Enter submits (keyboard-wedge scanners append CR) */}
      <div className="flex flex-shrink-0 gap-2 px-3 pt-3">
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && onSearchSubmit) {
              e.preventDefault()
              onSearchSubmit(searchQuery)
            }
          }}
          placeholder="Cari nama, SKU, atau pindai barcode"
          aria-label="Cari atau scan produk"
          className="h-12 min-w-0 flex-1 rounded-control border border-paper-2 bg-white px-4 text-base text-ink-900 placeholder:text-ink-500 focus:outline-none focus:ring-2 focus:ring-paper-2"
        />
        {onScanClick && (
          <button
            type="button"
            onClick={onScanClick}
            className="touch flex flex-shrink-0 items-center justify-center rounded-control border border-paper-2 bg-white text-ink-700 active:bg-paper-1"
            title="Scan barcode / QR"
            aria-label="Scan barcode atau QR"
          >
            <IconScan size={22} />
          </button>
        )}
      </div>

      {/* Category chips */}
      <div className="flex flex-shrink-0 gap-2 overflow-x-auto px-3 py-3">
        <Chip selected={selectedCategoryId === null} onClick={() => onCategoryChange(null)} className="flex-shrink-0">
          Semua
        </Chip>
        {categories.map((cat) => (
          <Chip key={cat.id} selected={selectedCategoryId === cat.id} onClick={() => onCategoryChange(cat.id)} className="flex-shrink-0">
            {cat.name}
          </Chip>
        ))}
        <Chip selected={showFavouritesOnly} onClick={onToggleFavourites} className="flex-shrink-0">
          <IconHeart size={16} /> Favorit
        </Chip>
      </div>

      {/* Product grid */}
      <div className="flex-1 overflow-y-auto px-3 pb-3">
        {isLoading ? (
          <div className="flex h-32 items-center justify-center text-sm text-ink-500">
            Memuat produk…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-ink-500">
            Produk tidak ditemukan
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={filtered.map((p) => p.id)} strategy={rectSortingStrategy}>
              <div className={`grid ${colClass[gridCols] ?? 'grid-cols-4'} gap-2`}>
                {filtered.map((product) => (
                  <SortableCard key={product.id} product={product} gridCols={gridCols}
                    categoryName={product.categoryId ? categoryNames.get(product.categoryId) : undefined}
                    showPrice={showPrice} showStock={showStock} showVariants={showVariants}
                    onTap={handleProductClick} />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>

      {/* Variant sheet */}
      <Sheet
        open={variantPopup !== null}
        onClose={() => setVariantPopup(null)}
        variant="center"
        z={50}
        panelClassName="overflow-hidden"
        title={<span className="block px-5 pt-5 pb-2 text-lg text-ink-900">{variantPopup?.name}</span>}
      >
        {variantPopup && (
          <div className="px-5 pb-5">
            <div className="divide-y divide-paper-2">
              {variantPopup.variants.map((v) => (
                <div key={v.size} className="flex min-h-16 items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    {variantLabel(v.size) && <p className="text-base font-semibold text-ink-900">{variantLabel(v.size)}</p>}
                    <p className="tnum text-[0.9375rem] text-ink-700">{formatRupiah(v.price)}</p>
                    <p className={`tnum text-[0.8125rem] font-semibold ${STOCK_TEXT_CLASS[stockTone(v.stock)]}`}>{stockLabel(v.stock)}</p>
                  </div>
                  <Stepper
                    value={variantQtys[v.size] || 0}
                    min={0}
                    onDecrement={() => handleVariantChange(v.size, -1)}
                    onIncrement={() => handleVariantChange(v.size, 1)}
                  />
                </div>
              ))}
            </div>
            {oversoldSizes(variantPopup, variantQtys, () => 0).length > 0 && (
              <p role="status" className="mt-3 rounded-control bg-warn-bg px-3 py-2 text-xs font-semibold text-warn">
                Jumlah melebihi stok. Tetap bisa ditambahkan; penjualan dicatat sebagai stok minus.
              </p>
            )}
            <button type="button"
              onClick={handleConfirmVariants}
              disabled={Object.values(variantQtys).reduce((a, b) => a + b, 0) === 0}
              className="mt-4 min-h-14 w-full rounded-control bg-ink-900 text-base font-bold text-white disabled:opacity-40 active:opacity-90"
            >
              Tambah ke Keranjang
            </button>
          </div>
        )}
      </Sheet>
    </div>
  )
})
