import type { Category } from '@mandalika/api'
import { FilterBar } from '../../ui/FilterBar'
import { SORT_OPTIONS, STATUS_ITEMS, STOCK_ITEMS, type ProductsListState } from './productsListState'

interface ProductsFiltersProps {
  state: ProductsListState
  categories: readonly Category[]
  activeCount: number
  onChange: (patch: Partial<ProductsListState>) => void
  onReset: () => void
}

export function ProductsFilters({ state, categories, activeCount, onChange, onReset }: ProductsFiltersProps) {
  const categoryOptions = [{ value: '', label: 'Semua kategori' }, ...categories.map((c) => ({ value: c.id, label: c.name }))]
  return (
    <FilterBar onReset={onReset} activeCount={activeCount}>
      <FilterBar.Search label="Cari produk" placeholder="Nama, brand, SKU atau barcode" value={state.q} onChange={(q) => onChange({ q })} />
      <FilterBar.Select label="Kategori" value={state.kategori} onChange={(kategori) => onChange({ kategori })} options={categoryOptions} />
      <FilterBar.Select label="Urutkan" value={state.urut} onChange={(urut) => onChange({ urut })} options={SORT_OPTIONS} />
      <FilterBar.Chips label="Status produk" items={STATUS_ITEMS} value={state.status} onChange={(status) => onChange({ status })} />
      <FilterBar.Chips label="Stok" items={STOCK_ITEMS} value={state.stok} onChange={(stok) => onChange({ stok })} />
    </FilterBar>
  )
}
