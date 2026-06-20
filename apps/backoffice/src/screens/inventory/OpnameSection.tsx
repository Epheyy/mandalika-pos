import { useState } from 'react'
import { Tabs } from '../../ui/Tabs'
import StockCount from '../StockCount'
import OpnameTab from '../ingredients/OpnameTab'

type OpnameSubTab = 'produk' | 'bahan'

const PRODUK_ONLY_TABS: ReadonlyArray<{ id: OpnameSubTab; label: string }> = [
  { id: 'produk', label: 'Produk' },
]

const ALL_TABS: ReadonlyArray<{ id: OpnameSubTab; label: string }> = [
  { id: 'produk', label: 'Produk' },
  { id: 'bahan', label: 'Bahan' },
]

interface OpnameSectionProps {
  recipesEnabled: boolean
}

export default function OpnameSection({ recipesEnabled }: OpnameSectionProps) {
  const [subTab, setSubTab] = useState<OpnameSubTab>('produk')
  const tabs = recipesEnabled ? ALL_TABS : PRODUK_ONLY_TABS

  return (
    <div>
      {recipesEnabled && (
        <div className="px-6 pt-4 pb-2">
          <Tabs value={subTab} onChange={(v) => setSubTab(v as OpnameSubTab)} tabs={tabs} />
        </div>
      )}
      {subTab === 'produk' && <StockCount />}
      {subTab === 'bahan' && recipesEnabled && (
        <div className="px-6 pb-6 pt-2">
          <OpnameTab />
        </div>
      )}
    </div>
  )
}
