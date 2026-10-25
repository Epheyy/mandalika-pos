import { useState } from 'react'
import type { Product } from '@mandalika/api'
import { variantOptions } from './variantOptions'

interface Props {
  products: readonly Product[]
  /** Keys (productId|size) already on the form, shown as added. */
  taken: ReadonlySet<string>
  onPick: (o: { productId: string; productName: string; variantSize: string; sku: string }) => void
}

/** Search the cached catalog by name/SKU and add a product + size to the request. */
export function VariantPicker({ products, taken, onPick }: Props) {
  const [search, setSearch] = useState('')
  const options = variantOptions(products, search)
  return (
    <div className="border rounded-lg">
      <input
        value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Cari nama atau SKU"
        aria-label="Cari barang" className="w-full px-3 py-2 text-sm border-b rounded-t-lg outline-none"
      />
      <div className="max-h-56 overflow-auto">
        {options.length === 0 && <p className="p-3 text-sm text-gray-400">Barang tidak ditemukan.</p>}
        {options.map((o) => (
          <button
            type="button" key={o.key} onClick={() => onPick(o)}
            className="w-full text-left px-3 py-2 border-b last:border-b-0 hover:bg-gray-50 flex justify-between gap-2"
          >
            <span className="text-sm text-gray-800">
              {o.productName} · {o.variantSize}{o.sku ? ` (${o.sku})` : ''}
              {taken.has(o.key) && <span className="ml-2 text-xs text-indigo-600">sudah ditambahkan</span>}
            </span>
            <span className="text-xs text-gray-400 shrink-0">Stok outlet: {o.stock}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
