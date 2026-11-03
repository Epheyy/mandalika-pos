import { useAuth } from '../auth'
import { useScreenTabs } from '../lib/router/useScreenTabs'
import { Tabs } from '../ui/Tabs'
import { CodesTab } from './promotions/CodesTab'
import { PromotionsTab } from './promotions/PromotionsTab'

type PromotionsTabKey = 'promotions' | 'codes'

/** Promosi and Kode Diskon: two routed tabs (#/promosi, #/promosi/kode), each a server-paged list with URL filters. */
export default function Promotions() {
  const { user } = useAuth()
  // The tab lives in the path; a bare #/promosi is Promosi.
  const { strip, tab: routedTab, setTab } = useScreenTabs<PromotionsTabKey>('promotions', user)
  const tab = routedTab ?? 'promotions'
  const tabs = <Tabs value={tab} onChange={setTab} tabs={strip} />

  return (
    <div className="p-6 space-y-5">
      {tab === 'promotions' && <PromotionsTab tabs={tabs} />}
      {tab === 'codes' && <CodesTab tabs={tabs} />}
    </div>
  )
}
