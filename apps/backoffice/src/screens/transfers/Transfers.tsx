import type { Outlet, Warehouse } from '@mandalika/api'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { navigate } from '../../lib/router/navigate'
import { useRoute } from '../../lib/router/useRoute'
import { TransferDetail } from './TransferDetail'
import { TransferForm } from './TransferForm'
import { TransferList } from './TransferList'
import { transferHash, transferViewFromPath } from './transferRoute'

export function Transfers() {
  // The view lives in the path: #/inventori/transfer, /baru, /<id>.
  const view = transferViewFromPath(useRoute().path)
  const toList = () => void navigate(transferHash({ kind: 'list' }))
  // Locations for the create form and the list filter (loaded once at this level).
  const oq = usePolledQuery<Outlet[]>(() => api.listOutlets(), [])
  const wq = usePolledQuery<Warehouse[]>(() => api.listWarehouses(), [])

  if (view.kind === 'create') {
    return (
      <TransferForm
        outlets={oq.data ?? []}
        warehouses={wq.data ?? []}
        onCancel={toList}
        onCreated={(id) => void navigate(transferHash({ kind: 'detail', id }), { replace: true })}
      />
    )
  }
  if (view.kind === 'detail') {
    return <TransferDetail id={view.id} onBack={toList} />
  }
  return (
    <TransferList
      outlets={oq.data ?? []}
      warehouses={wq.data ?? []}
      onCreate={() => void navigate(transferHash({ kind: 'create' }))}
      onOpen={(id) => void navigate(transferHash({ kind: 'detail', id }))}
    />
  )
}
