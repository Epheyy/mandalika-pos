import { useRouteTab } from '../../lib/router/useRouteTab'
import { PageHeader } from '../../ui/PageHeader'
import { Tabs } from '../../ui/Tabs'
import { MovementSummary } from './MovementSummary'
import { OverviewMatrix } from './OverviewMatrix'
import { StockCard } from './StockCard'

type SubTab = 'overview' | 'pergerakan' | 'kartu'

const SUB_TABS: ReadonlyArray<{ id: SubTab; label: string }> = [
  { id: 'overview', label: 'Ikhtisar' },
  { id: 'pergerakan', label: 'Pergerakan' },
  { id: 'kartu', label: 'Kartu Stok' },
]

// #/inventori/stok/<slug>; a bare #/inventori/stok is Ikhtisar.
const BASE = ['inventori', 'stok'] as const
const PATH_TABS: ReadonlyArray<{ key: SubTab; slug: string }> = [
  { key: 'overview', slug: 'ikhtisar' },
  { key: 'pergerakan', slug: 'pergerakan' },
  { key: 'kartu', slug: 'kartu-stok' },
]

export default function StokProduk() {
  const [routed, setSubTab] = useRouteTab<SubTab>(BASE, PATH_TABS)
  const subTab = routed ?? 'overview'
  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="Stok Produk"
        subtitle="Ikhtisar dan pergerakan stok di semua lokasi"
      />

      <Tabs value={subTab} onChange={setSubTab} tabs={SUB_TABS} />

      {subTab === 'overview' && <OverviewMatrix />}

      {subTab === 'pergerakan' && <MovementSummary />}

      {subTab === 'kartu' && <StockCard />}
    </div>
  )
}
