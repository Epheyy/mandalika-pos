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
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 bg-amber-50 border border-amber-200 text-amber-700 rounded-full px-3 py-1.5 text-xs font-bold"
      >
        {versions.length === 0 ? 'Belum ada versi' : `Versi ${activeNo}${isCurrent ? ' (kini)' : ''}`}
        <ChevronDown className="w-3 h-3" />
      </button>
      {open && versions.length > 0 && (
        <div className="absolute z-20 mt-1 w-64 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden">
          {versions.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => {
                setOpen(false)
                if (v.id === currentVersionId) onBackToCurrent()
                else onSelect(v.id)
              }}
              className={`w-full text-left px-3 py-2 text-xs border-b border-gray-50 last:border-0 hover:bg-gray-50 ${v.id === activeId ? 'bg-amber-50' : ''}`}
            >
              <div className="font-bold text-gray-800">
                Versi {v.versionNo}{v.id === currentVersionId ? ' (kini)' : ''}
              </div>
              <div className="text-gray-400">{fmtDate(v.createdAt)} · {v.createdByName ?? '—'}</div>
              {v.notes && <div className="text-gray-500 truncate">{v.notes}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
