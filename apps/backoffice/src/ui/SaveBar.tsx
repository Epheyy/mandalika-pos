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
    <div className="sticky bottom-0 z-10 -mx-6 -mb-6 px-6 py-3 bg-white border-t border-amber-300 shadow-[0_-4px_12px_rgba(0,0,0,0.06)]" data-testid="save-bar">
      {notice}
      {count === 0 && status === 'saved' && (
        <p role="status" className="flex items-center gap-2 text-sm font-bold text-green-700">
          <CheckCircle2 className="w-4 h-4" /> {message}
        </p>
      )}
      {status === 'error' && message && (
        <p role="alert" className="flex items-center gap-2 text-sm font-bold text-red-600 mb-2">
          <AlertCircle className="w-4 h-4" /> {message}
        </p>
      )}
      {count > 0 && (
        <div className="flex items-center gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-black text-gray-900">{count} perubahan belum disimpan</p>
            <p className="text-xs text-gray-500 truncate" title={items.join(' · ')}>{listed}{more}</p>
          </div>
          <Button variant="ghost" onClick={onDiscard} disabled={saving}>Batalkan perubahan</Button>
          <Button onClick={onSave} loading={saving}>{saving ? 'Menyimpan...' : 'Simpan perubahan'}</Button>
        </div>
      )}
    </div>
  )
}
