import { memo, useCallback, useMemo, useState, type CSSProperties } from 'react'
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
import { variantLabel } from '@mandalika/types'

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
}

interface SortableCardProps {
  product: Product
  showPrice: boolean
  showStock: boolean
  showVariants: boolean
  onTap: (product: Product) => void
}

const SortableCard = memo(function SortableCard({ product, showPrice, showStock, showVariants, onTap }: SortableCardProps) {
  const totalStock = product.variants.reduce((s, v) => s + v.stock, 0)
  const inStock = totalStock > 0
  const prices = product.variants.map((v) => v.price)
  const minPrice = prices.length ? Math.min(...prices) : 0
  const maxPrice = prices.length ? Math.max(...prices) : 0
  // Compact price for small grids: a single price, or the minimum with "+"
  // when variants differ (e.g. "Rp 250.000+").
  const priceLabel = minPrice === maxPrice ? formatRupiah(minPrice) : `${formatRupiah(minPrice)}+`
  const initial = (product.name || '?').charAt(0).toUpperCase()

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
      tabIndex={inStock ? 0 : -1}
      onClick={() => { if (inStock) onTap(product) }}
      onKeyDown={(e) => {
        if (inStock && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          onTap(product)
        }
      }}
      className={`group flex flex-col rounded-xl border text-left overflow-hidden select-none touch-manipulation ${
        inStock
          ? 'border-gray-200 bg-white cursor-pointer hover:border-indigo-300 hover:shadow-md active:scale-[0.98]'
          : 'border-gray-100 bg-gray-50 cursor-not-allowed'
      } ${isDragging ? 'shadow-lg ring-2 ring-indigo-300' : 'transition-all duration-150'}`}
    >
      {/* Media — uniform aspect-square so every card is the same height,
          whether the product has a photo or a fallback initial tile. */}
      <div className="relative w-full aspect-square overflow-hidden">
        {product.imageUrl ? (
          <img
            src={product.imageUrl}
            alt={product.name}
            className={`w-full h-full object-cover pointer-events-none transition-transform duration-200 ${inStock ? 'group-hover:scale-105' : 'grayscale opacity-60'}`}
            loading="lazy"
            draggable={false}
          />
        ) : (
          <div className={`w-full h-full flex items-center justify-center bg-gradient-to-br from-indigo-50 to-indigo-100 ${!inStock ? 'opacity-60' : ''}`}>
            <span className="text-3xl font-black text-indigo-300 select-none">{initial}</span>
          </div>
        )}
        {!inStock && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/40">
            <span className="px-2 py-0.5 text-[10px] font-black uppercase tracking-wide bg-red-500 text-white rounded-full">Habis</span>
          </div>
        )}
      </div>

      <div className="p-2">
        <p className="text-xs font-semibold text-gray-800 line-clamp-2 leading-tight min-h-[2.1em]">
          {product.name}
        </p>
        {showVariants ? (
          /* Per-variant rows — each variant's own price/stock, not an
             accumulated total. */
          <div className="mt-1 space-y-0.5">
            {product.variants.map((v) => (
              <div key={v.size} className="flex items-baseline justify-between gap-1.5 text-[10px]">
                {variantLabel(v.size) && <span className="text-gray-600 truncate">{variantLabel(v.size)}</span>}
                {(showPrice || showStock) && (
                  <span className="flex-shrink-0 flex items-center gap-1.5">
                    {showPrice && <span className="font-bold text-indigo-600">{formatRupiah(v.price)}</span>}
                    {showStock && <span className={v.stock > 0 ? 'text-gray-400' : 'text-red-500 font-semibold'}>Stok {v.stock}</span>}
                  </span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <>
            {showPrice && (
              <p className="mt-1 text-[11px] font-black text-indigo-600 truncate">{priceLabel}</p>
            )}
            {showStock && (
              <p className={`text-[10px] ${inStock ? 'text-gray-400' : 'text-red-500 font-semibold'}`}>
                {inStock ? `Stok ${totalStock}` : 'Stok habis'}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
})

const colClass: Record<number, string> = {
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-4',
  6: 'grid-cols-6',
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
}: ProductGridProps) {
  const [variantPopup, setVariantPopup] = useState<Product | null>(null)
  const [variantQtys, setVariantQtys] = useState<Record<string, number>>({})
  const [order, setOrder] = useState<string[]>(loadOrder)

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
    const variant = variantPopup.variants.find((v) => v.size === size)
    if (!variant) return
    setVariantQtys((prev) => ({
      ...prev,
      [size]: Math.max(0, Math.min((prev[size] || 0) + delta, variant.stock)),
    }))
  }

  const handleConfirmVariants = () => {
    if (!variantPopup) return
    onProductTap(variantPopup, variantQtys)
    setVariantPopup(null)
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Search bar — Enter submits (keyboard-wedge scanners append CR) */}
      <div className="px-3 py-2 border-b border-gray-100 flex-shrink-0 flex gap-2">
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
          placeholder="Cari / scan produk…"
          aria-label="Cari atau scan produk"
          className="flex-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-400"
        />
        {onScanClick && (
          <button
            type="button"
            onClick={onScanClick}
            className="flex-shrink-0 px-3 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 active:scale-95 transition"
            title="Scan barcode / QR"
            aria-label="Scan barcode atau QR"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M3 12h18"/></svg>
          </button>
        )}
      </div>

      {/* Category tabs */}
      <div className="flex gap-1 px-3 py-2 overflow-x-auto flex-shrink-0 border-b border-gray-100">
        <button type="button"
          onClick={() => onCategoryChange(null)}
          className={`flex-shrink-0 px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
            selectedCategoryId === null
              ? 'bg-indigo-600 text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          Semua
        </button>
        {categories.map((cat) => (
          <button type="button"
            key={cat.id}
            onClick={() => onCategoryChange(cat.id)}
            className={`flex-shrink-0 px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
              selectedCategoryId === cat.id
                ? 'bg-indigo-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {cat.name}
          </button>
        ))}
        <button type="button"
          onClick={onToggleFavourites}
          className={`flex-shrink-0 px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
            showFavouritesOnly
              ? 'bg-pink-500 text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          ♥ Favorit
        </button>
      </div>

      {/* Product grid */}
      <div className="flex-1 overflow-y-auto p-3">
        {isLoading ? (
          <div className="flex items-center justify-center h-32 text-gray-400 text-sm">
            Memuat produk…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-gray-400 text-sm">
            Produk tidak ditemukan
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={filtered.map((p) => p.id)} strategy={rectSortingStrategy}>
              <div className={`grid ${colClass[gridCols] ?? 'grid-cols-4'} gap-2`}>
                {filtered.map((product) => (
                  <SortableCard key={product.id} product={product}
                    showPrice={showPrice} showStock={showStock} showVariants={showVariants}
                    onTap={handleProductClick} />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>

      {/* Variant popup */}
      {variantPopup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Tutup"
            tabIndex={-1}
            className="absolute inset-0 bg-black/40"
            onClick={() => setVariantPopup(null)}
          />
          <div className="relative bg-white rounded-2xl w-full max-w-sm p-5 shadow-xl">
            <h3 className="font-bold text-gray-900 mb-4">{variantPopup.name}</h3>
            <div className="space-y-3 mb-5">
              {variantPopup.variants.map((v) => (
                <div key={v.size} className="flex items-center justify-between">
                  <div>
                    {variantLabel(v.size) && <p className="text-sm font-semibold text-gray-700">{variantLabel(v.size)}</p>}
                    <p className="text-xs text-indigo-600">{formatRupiah(v.price)}</p>
                    <p className="text-xs text-gray-400">Stok: {v.stock}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button type="button"
                      onClick={() => handleVariantChange(v.size, -1)}
                      disabled={(variantQtys[v.size] || 0) === 0}
                      className="w-7 h-7 rounded-full border border-gray-300 flex items-center justify-center text-gray-600 hover:bg-gray-100 disabled:opacity-40"
                    >
                      −
                    </button>
                    <span className="w-6 text-center text-sm font-bold">
                      {variantQtys[v.size] || 0}
                    </span>
                    <button type="button"
                      onClick={() => handleVariantChange(v.size, 1)}
                      disabled={(variantQtys[v.size] || 0) >= v.stock}
                      className="w-7 h-7 rounded-full border border-gray-300 flex items-center justify-center text-gray-600 hover:bg-gray-100 disabled:opacity-40"
                    >
                      +
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <button type="button"
              onClick={handleConfirmVariants}
              disabled={Object.values(variantQtys).reduce((a, b) => a + b, 0) === 0}
              className="w-full py-2.5 bg-indigo-600 text-white rounded-xl font-semibold text-sm disabled:opacity-40 hover:bg-indigo-700 transition-colors"
            >
              Tambah ke Keranjang
            </button>
          </div>
        </div>
      )}
    </div>
  )
})
