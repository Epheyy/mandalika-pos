/**
 * Lets multi-outlet users pick their active outlet.
 * Sets authStore.outletId and triggers engine.resync (via callback).
 * For cashiers with a single fixed outlet this is hidden.
 */

import { memo, useContext, useState } from 'react'
import type { components } from '@mandalika/api'
import { api, authStore } from '../api'
import { SyncContext } from '../cashier/SyncProvider'

type Outlet = components['schemas']['Outlet']
type User = components['schemas']['User']

interface OutletSwitcherProps {
  user: User
  onResync: () => Promise<void>
}

export const OutletSwitcher = memo(function OutletSwitcher({
  user,
  onResync,
}: OutletSwitcherProps) {
  const engine = useContext(SyncContext)
  const [outlets, setOutlets] = useState<Outlet[]>([])
  const [isOpen, setIsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [currentOutletId, setCurrentOutletId] = useState<string | null>(
    authStore.outletId,
  )

  // Admin or manager (no fixed outlet) can switch
  const canSwitch = user.role === 'admin' || user.role === 'manager'
  if (!canSwitch) return null

  const handleOpen = async () => {
    setIsLoading(true)
    try {
      const r = await api.request<{ data: Outlet[] }>(
        'GET',
        '/api/v1/outlets',
      )
      setOutlets(r.data)
      setIsOpen(true)
    } catch {
      // silent
    } finally {
      setIsLoading(false)
    }
  }

  const handleSelect = async (outlet: Outlet) => {
    authStore.outletId = outlet.id
    setCurrentOutletId(outlet.id)
    setIsOpen(false)
    if (engine) {
      await onResync()
    }
  }

  const label = outlets.find((o) => o.id === currentOutletId)?.name ?? 'Outlet'

  return (
    <>
      <button type="button"
        onClick={handleOpen}
        disabled={isLoading}
        className="text-xs text-gray-600 hover:text-indigo-600 px-2 py-1 rounded-lg hover:bg-indigo-50 transition-colors font-semibold"
      >
        {isLoading ? '…' : label} ▾
      </button>

      {isOpen && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-xs shadow-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-gray-900 text-sm">Pilih Outlet</h3>
              <button type="button"
                onClick={() => setIsOpen(false)}
                className="text-gray-400 hover:text-gray-600"
              >
                ×
              </button>
            </div>
            <div className="space-y-1">
              {outlets.map((o) => (
                <button type="button"
                  key={o.id}
                  onClick={() => void handleSelect(o)}
                  className={`w-full text-left px-3 py-2.5 rounded-xl text-sm transition-colors ${
                    o.id === currentOutletId
                      ? 'bg-indigo-600 text-white font-semibold'
                      : 'hover:bg-gray-50 text-gray-700'
                  }`}
                >
                  <p className="font-semibold">{o.name}</p>
                  {o.address && (
                    <p
                      className={`text-xs ${
                        o.id === currentOutletId
                          ? 'text-indigo-200'
                          : 'text-gray-400'
                      }`}
                    >
                      {o.address}
                    </p>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  )
})
