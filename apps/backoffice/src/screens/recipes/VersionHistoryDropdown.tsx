import { useState } from 'react'
import type { RecipeVersionSummary } from '@mandalika/api'
import { ChevronDown } from 'lucide-react'

interface Props {
  versions: RecipeVersionSummary[]
  currentVersionId: string | null
  viewingVersionId: string | null
  onSelect: (versionId: string) => void
  onBackToCurrent: () => void
}

function fmtDate(iso: string): string {
  try { return new Date(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }) } catch { return iso }
}

export function VersionHistoryDropdown({ versions, currentVersionId, viewingVersionId, onSelect, onBackToCurrent }: Props) {
  const [open, setOpen] = useState(false)
  const activeId = viewingVersionId ?? currentVersionId
  const activeNo = versions.find((v) => v.id === activeId)?.versionNo ?? 0
  const isCurrent = viewingVersionId === null

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 h-9 border border-paper-2 bg-paper-1 text-ink-900 rounded-full px-3 text-xs font-bold focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-strong"
      >
        {versions.length === 0 ? 'Belum ada versi' : `Versi ${activeNo}${isCurrent ? ' (kini)' : ''}`}
        <ChevronDown className="w-3 h-3" />
      </button>
      {open && versions.length > 0 && (
        <div className="surface-solid absolute z-20 mt-1 w-64 rounded-xl overflow-hidden">
          {versions.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => {
                setOpen(false)
                if (v.id === currentVersionId) onBackToCurrent()
                else onSelect(v.id)
              }}
              className={`w-full text-left px-3 py-2 text-xs border-b border-paper-2 last:border-0 hover:bg-paper-1 ${v.id === activeId ? 'bg-paper-1' : ''}`}
            >
              <div className="font-bold text-ink-900">
                Versi {v.versionNo}{v.id === currentVersionId ? ' (kini)' : ''}
              </div>
              <div className="text-ink-700">{fmtDate(v.createdAt)} · {v.createdByName ?? '—'}</div>
              {v.notes && <div className="text-ink-700 truncate" title={v.notes}>{v.notes}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
