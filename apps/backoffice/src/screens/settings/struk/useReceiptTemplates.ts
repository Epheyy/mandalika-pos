import { useCallback, useEffect, useRef, useState } from 'react'
import type { Outlet, ReceiptTemplate } from '@mandalika/api'
import { api } from '../../../api'

export interface ReceiptTemplatesData {
  templates: ReceiptTemplate[]
  outlets: Outlet[]
  loaded: boolean
  loadError: string | null
  /** Fetches both lists again and returns the fresh templates (null when the fetch failed). */
  reload: () => Promise<ReceiptTemplate[] | null>
}

/** Loads the stored templates and the outlets once, and again on `reload`. No polling: the draft lives in the
 *  designer, so a refresh must only happen when the admin asks for it or has just saved. */
export function useReceiptTemplates(): ReceiptTemplatesData {
  const [templates, setTemplates] = useState<ReceiptTemplate[]>([])
  const [outlets, setOutlets] = useState<Outlet[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const alive = useRef(true)

  const reload = useCallback(async (): Promise<ReceiptTemplate[] | null> => {
    try {
      const [t, o] = await Promise.all([api.listReceiptTemplates(), api.listOutlets()])
      if (!alive.current) return null
      setTemplates(t)
      setOutlets(o)
      setLoaded(true)
      setLoadError(null)
      return t
    } catch (e: unknown) {
      if (alive.current) setLoadError(e instanceof Error ? e.message : 'Gagal memuat template.')
      return null
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void reload()
    return () => {
      alive.current = false
    }
  }, [reload])

  return { templates, outlets, loaded, loadError, reload }
}
