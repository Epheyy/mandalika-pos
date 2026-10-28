import { useEffect, useState, useSyncExternalStore } from 'react'
import { reloadToApplyOta, watchOtaUpdates } from '../otaUpdate'
import { createOtaUpdateController, type OtaUpdateController } from '../lib/otaUpdateController'

/** C5 (D-19): the "Versi baru siap" state. Off-device it never reports anything, so `pending` stays null. */
export function useOtaUpdate(): { state: ReturnType<OtaUpdateController['getSnapshot']>; controller: OtaUpdateController } {
  const [controller] = useState(() => createOtaUpdateController({ watch: watchOtaUpdates, reload: reloadToApplyOta }))
  useEffect(() => {
    controller.start()
    return () => controller.stop()
  }, [controller])
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  return { state, controller }
}
