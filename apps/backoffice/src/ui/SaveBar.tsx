import type { ReactNode } from 'react'
import { AlertCircle, CheckCircle2 } from 'lucide-react'
import { Button } from './Button'

export type SaveBarStatus = 'idle' | 'saving' | 'saved' | 'error'

interface SaveBarProps {
  /** Number of unsaved changes. */
  count: number
  /** Plain-words list of what changed. */
  items: readonly string[]
  status: SaveBarStatus
  /** Shown for `saved` and `error`. */
  message?: string
  onSave: () => void
  onDiscard: () => void
  /** Extra content above the actions (e.g. conflict prompts). */
  notice?: ReactNode
}

const MAX_LISTED = 3

/** Sticky bottom bar of a form screen. Renders nothing until there is something to say. */
export function SaveBar({ count, items, status, message, onSave, onDiscard, notice }: SaveBarProps) {
  if (count === 0 && status === 'idle') return null
  const saving = status === 'saving'
  const listed = items.slice(0, MAX_LISTED).join(' · ')
  const more = items.length > MAX_LISTED ? ` · dan ${items.length - MAX_LISTED} lainnya` : ''
  return (
    <div className="sticky bottom-3 z-10 mt-4 rounded-2xl border border-paper-2 bg-(--surface-solid-bg) px-5 py-3 shadow-[0_12px_28px_-14px_rgba(70,46,10,0.4)]" data-testid="save-bar">
      {notice}
      {count === 0 && status === 'saved' && (
        <p role="status" className="flex items-center gap-2 text-sm font-bold text-ok">
          <CheckCircle2 className="w-4 h-4" /> {message}
        </p>
      )}
      {status === 'error' && message && (
        <p role="alert" className="flex items-center gap-2 text-sm font-bold text-danger mb-2">
          <AlertCircle className="w-4 h-4" /> {message}
        </p>
      )}
      {count > 0 && (
        <div className="flex items-center gap-4">
          <div className="flex-1 min-w-0">
            <p className="flex items-center gap-2 text-sm font-bold text-warn-strong">
              <span aria-hidden="true" className="h-2 w-2 flex-shrink-0 rounded-full bg-current" />
              {count} perubahan belum disimpan
            </p>
            <p className="text-xs text-ink-700 truncate" title={items.join(' · ')}>{listed}{more}</p>
          </div>
          <Button variant="secondary" onClick={onDiscard} disabled={saving}>Batalkan perubahan</Button>
          <Button onClick={onSave} loading={saving}>{saving ? 'Menyimpan...' : 'Simpan perubahan'}</Button>
        </div>
      )}
    </div>
  )
}
