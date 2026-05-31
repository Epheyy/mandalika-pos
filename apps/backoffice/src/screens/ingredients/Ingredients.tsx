import { useState } from 'react'
import DaftarTab from './DaftarTab'
import StokMasukTab from './StokMasukTab'
import PenyesuaianTab from './PenyesuaianTab'
import TransferTab from './TransferTab'
import { IngredientOverviewMatrix } from './IngredientOverviewMatrix'

type Inner = 'overview' | 'daftar' | 'stok-masuk' | 'penyesuaian' | 'transfer'

const INNER_TABS: { id: Inner; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'daftar', label: 'Daftar' },
  { id: 'stok-masuk', label: 'Stok Masuk' },
  { id: 'penyesuaian', label: 'Penyesuaian' },
  { id: 'transfer', label: 'Transfer' },
]

export default function Ingredients() {
  const [inner, setInner] = useState<Inner>('overview')

  const cls = (k: Inner) =>
    `px-3 py-1.5 text-sm transition-colors ${
      inner === k
        ? 'font-semibold border-b-2 border-gold-600 text-gold-700'
        : 'text-gray-600 hover:text-gray-900'
    }`

  return (
    <div>
      <div className="flex gap-2 border-b border-gray-200 mb-4">
        {INNER_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setInner(t.id)}
            className={cls(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {inner === 'overview' && <IngredientOverviewMatrix />}
      {inner === 'daftar' && <DaftarTab />}
      {inner === 'stok-masuk' && <StokMasukTab />}
      {inner === 'penyesuaian' && <PenyesuaianTab />}
      {inner === 'transfer' && <TransferTab />}
    </div>
  )
}
