import { useState } from 'react'
import { PageHeader } from '../../ui/PageHeader'
import { Tabs } from '../../ui/Tabs'
import { MovementSummary } from './MovementSummary'
import { OverviewMatrix } from './OverviewMatrix'
import { StockCard, type StockCardTarget } from './StockCard'

type SubTab = 'overview' | 'pergerakan' | 'kartu'

const SUB_TABS: ReadonlyArray<{ id: SubTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'pergerakan', label: 'Pergerakan' },
  { id: 'kartu', label: 'Kartu Stok' },
]

export default function StokProduk() {
  const [subTab, setSubTab] = useState<SubTab>('overview')
  // A summary row click opens the card on that SKU; the key remounts the card for each new target.
  const [target, setTarget] = useState<StockCardTarget | null>(null)
  const [targetKey, setTargetKey] = useState(0)

  const openCard = (t: StockCardTarget) => {
    setTarget(t)
    setTargetKey((k) => k + 1)
    setSubTab('kartu')
  }

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="Stok Produk"
        subtitle="Overview dan pergerakan stok di semua lokasi"
      />

      <Tabs value={subTab} onChange={setSubTab} tabs={SUB_TABS} />

      {subTab === 'overview' && <OverviewMatrix />}

      {subTab === 'pergerakan' && <MovementSummary onOpenCard={openCard} />}

      {subTab === 'kartu' && <StockCard key={targetKey} target={target} />}
    </div>
  )
}
