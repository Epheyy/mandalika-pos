import { useRouteTab } from '../../lib/router/useRouteTab'
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

// #/inventori/opname/<slug>; a bare #/inventori/opname is Produk. Bahan only exists once recipesEnabled has loaded.
const BASE = ['inventori', 'opname'] as const
const PRODUK_PATH: ReadonlyArray<{ key: OpnameSubTab; slug: string }> = [{ key: 'produk', slug: 'produk' }]
const ALL_PATH: ReadonlyArray<{ key: OpnameSubTab; slug: string }> = [...PRODUK_PATH, { key: 'bahan', slug: 'bahan' }]

interface OpnameSectionProps {
  recipesEnabled: boolean
}

export default function OpnameSection({ recipesEnabled }: OpnameSectionProps) {
  const [routed, setSubTab] = useRouteTab<OpnameSubTab>(BASE, recipesEnabled ? ALL_PATH : PRODUK_PATH)
  const subTab = routed ?? 'produk'
  const tabs = recipesEnabled ? ALL_TABS : PRODUK_ONLY_TABS

  return (
    <div>
      {recipesEnabled && (
        <div className="px-6 pt-4 pb-2">
          <Tabs value={subTab} onChange={setSubTab} tabs={tabs} />
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
