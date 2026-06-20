import { useState } from 'react'
import { PageHeader } from '../../ui/PageHeader'
import { Tabs } from '../../ui/Tabs'
import { MovementSummary } from './MovementSummary'
import { OverviewMatrix } from './OverviewMatrix'

type SubTab = 'overview' | 'pergerakan'

const SUB_TABS: ReadonlyArray<{ id: SubTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'pergerakan', label: 'Pergerakan' },
]

export default function StokProduk() {
  const [subTab, setSubTab] = useState<SubTab>('overview')

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="Stok Produk"
        subtitle="Overview dan pergerakan stok di semua lokasi"
      />

      <Tabs value={subTab} onChange={setSubTab} tabs={SUB_TABS} />

      {subTab === 'overview' && <OverviewMatrix />}

      {subTab === 'pergerakan' && <MovementSummary />}
    </div>
  )
}
