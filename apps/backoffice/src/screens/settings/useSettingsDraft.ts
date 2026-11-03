import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { AppSettings } from '@mandalika/api'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import {
  applyChanges,
  buildSaveBody,
  diffSettings,
  dirtyMarkers,
  findConflicts,
  normalize,
  rebaseOnFresh,
  resolveConflict,
  summarize,
  copyPath,
  type Conflict,
  type DraftState,
} from './settingsDiff'

const POLL_MS = 30000
const SAVED_VISIBLE_MS = 4000
export const SAVED_MESSAGE = 'Pengaturan disimpan · tablet mengambilnya saat sinkron berikutnya'

type Status = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string }

/** Baseline + draft of Pengaturan, with merge-on-save onto a fresh server copy (see settingsDiff.ts). */
export function useSettingsDraft() {
  const q = usePolledQuery<AppSettings>(() => api.getAppSettings(), [], POLL_MS)
  const [state, setState] = useState<DraftState & { loaded: boolean }>(() => ({ baseline: normalize(), draft: normalize(), loaded: false }))
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [conflicts, setConflicts] = useState<Conflict[]>([])
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  })
  const savingRef = useRef(false)
  const freshRef = useRef<AppSettings | null>(null)
  // Latest server copy seen by the poll or by a save, so Batalkan never resets to something older.
  const serverRef = useRef<AppSettings | null>(null)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(savedTimer.current), [])

  useEffect(() => {
    if (!q.data || savingRef.current) return
    const fresh = normalize(q.data)
    serverRef.current = fresh
    setState((prev) => (prev.loaded ? { ...rebaseOnFresh(prev, fresh), loaded: true } : { baseline: fresh, draft: fresh, loaded: true }))
  }, [q.data])

  const changes = useMemo(() => diffSettings(state.baseline, state.draft), [state.baseline, state.draft])
  const markers = useMemo(() => dirtyMarkers(changes), [changes])
  const items = useMemo(() => summarize(changes), [changes])

  const setDraft: Dispatch<SetStateAction<AppSettings>> = useCallback((u) => {
    setState((p) => ({ ...p, draft: typeof u === 'function' ? u(p.draft) : u }))
  }, [])

  const fail = useCallback((message: string) => setStatus({ kind: 'error', message }), [])

  const save = useCallback(async (): Promise<boolean> => {
    if (savingRef.current) return false
    savingRef.current = true
    clearTimeout(savedTimer.current)
    setStatus({ kind: 'saving' })
    try {
      const rawFresh = await api.getAppSettings({ fresh: true })
      const fresh = normalize(rawFresh)
      const { baseline, draft } = stateRef.current
      const pending = diffSettings(baseline, draft)
      const found = findConflicts(baseline, fresh, draft, pending)
      if (found.length > 0) {
        freshRef.current = fresh
        setConflicts(found)
        setStatus({ kind: 'idle' })
        return false
      }
      await api.updateAppSettings(buildSaveBody(rawFresh, fresh, draft, pending))
      let after: AppSettings
      try {
        after = normalize(await api.getAppSettings({ fresh: true }))
      } catch {
        after = applyChanges(fresh, draft, pending)
      }
      serverRef.current = after
      // Edits made while the save was in flight stay in the draft.
      setState((prev) => {
        let next = after
        for (const c of diffSettings(draft, prev.draft)) next = copyPath(next, c.path, prev.draft)
        return { baseline: after, draft: next, loaded: true }
      })
      setConflicts([])
      setStatus({ kind: 'saved' })
      savedTimer.current = setTimeout(() => setStatus((s) => (s.kind === 'saved' ? { kind: 'idle' } : s)), SAVED_VISIBLE_MS)
      return true
    } catch (e: unknown) {
      setStatus({ kind: 'error', message: e instanceof Error ? e.message : 'Gagal menyimpan.' })
      return false
    } finally {
      savingRef.current = false
    }
  }, [])

  const discard = useCallback(() => {
    const base = serverRef.current ?? stateRef.current.baseline
    setState({ baseline: base, draft: base, loaded: true })
    setConflicts([])
    setStatus({ kind: 'idle' })
  }, [])

  const resolve = useCallback((path: string, choice: 'mine' | 'theirs') => {
    const fresh = freshRef.current
    if (!fresh) return
    setState((prev) => ({ ...resolveConflict(prev, fresh, path, choice), loaded: true }))
    setConflicts((prev) => prev.filter((c) => c.path !== path))
  }, [])

  return {
    draft: state.draft,
    setDraft,
    changes,
    items,
    markers,
    conflicts: conflicts.filter((c) => changes.some((ch) => ch.path === c.path)),
    resolve,
    status,
    save,
    discard,
    fail,
    loaded: state.loaded,
    loadError: q.error,
  }
}
