import { use, useEffect, useState } from 'react'
import { getKV } from '@mandalika/sync'
import { SyncContext } from '../cashier/SyncProvider'
import { readBinding, withOutletName, writeBinding } from '../terminalBinding'

/** Read-only outlet name for the header (never a UUID): the pulled snapshot's name, else the
 *  binding's. Once the snapshot knows the name it is also stored in the binding, so a restart
 *  that is offline before the first pull still shows it. */
export function useTerminalLabel(): string | null {
  const engine = use(SyncContext)
  const [label, setLabel] = useState<string | null>(null)
  useEffect(() => {
    const refresh = () => {
      const kv = getKV()
      const binding = readBinding(kv)
      const fromSnapshot = engine?.getSnapshot().outletName || null
      if (binding && fromSnapshot) {
        const named = withOutletName(binding, fromSnapshot)
        if (named) writeBinding(kv, named).catch((err) => console.error('[terminal] outlet name write failed', err))
      }
      setLabel(fromSnapshot || binding?.outletName || null)
    }
    refresh()
    const t = setInterval(refresh, 4000)
    return () => clearInterval(t)
  }, [engine])
  return label
}
