import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown, Download } from 'lucide-react'
import { Button } from './Button'

export type ExportFormat = 'csv' | 'xlsx'

export interface ExportButtonProps {
  /** Default ['csv']. One format = a button "Unduh CSV" / "Unduh Excel"; two = a menu button "Unduh". */
  formats?: readonly ExportFormat[]
  /** When two exports share a screen: "Unduh CSV refund". */
  qualifier?: string
  /** Shown "· 312"; null = unknown. */
  rowCount: number | null
  /** Tooltip: "Unduh CSV · 312 baris · Filter: …". */
  filterSummary: readonly string[]
  onExport: (format: ExportFormat) => Promise<void> | void
  /** Disabled at rowCount 0 as well. */
  disabled?: boolean
}

const FORMAT_NAME: Record<ExportFormat, string> = { csv: 'CSV', xlsx: 'Excel' }
const MENU_LABEL: Record<ExportFormat, string> = { csv: 'CSV (.csv)', xlsx: 'Excel (.xlsx)' }

/** The accessible name of the single-format button, e.g. "Unduh CSV refund". Exported for tests. */
export function exportButtonName(format: ExportFormat, qualifier?: string): string {
  return ['Unduh', FORMAT_NAME[format], qualifier].filter(Boolean).join(' ')
}

function tooltip(name: string, rowCount: number | null, filterSummary: readonly string[]): string {
  const rows = rowCount === null ? [] : [`${rowCount} baris`]
  const filters = `Filter: ${filterSummary.length > 0 ? filterSummary.join('; ') : 'tidak ada'}`
  return [name, ...rows, filters].join(' · ')
}

export function ExportButton({
  formats = ['csv'],
  qualifier,
  rowCount,
  filterSummary,
  onExport,
  disabled,
}: ExportButtonProps) {
  const [menu, setMenu] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!menu) return
    const outside = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setMenu(false)
    }
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(false)
    }
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [menu])

  const run = async (format: ExportFormat) => {
    setMenu(false)
    setFailure(null)
    setBusy(true)
    try {
      await onExport(format)
    } catch (e) {
      setFailure(e instanceof Error && e.message ? e.message : 'Unduhan gagal. Coba lagi.')
    } finally {
      setBusy(false)
    }
  }

  const off = disabled || rowCount === 0
  const count = rowCount === null ? null : <span aria-hidden="true"> · {rowCount}</span>
  const single = formats.length === 1 ? formats[0] : null
  const name = single ? exportButtonName(single, qualifier) : ['Unduh', qualifier].filter(Boolean).join(' ')

  return (
    <div className="relative inline-flex flex-col items-end" ref={root}>
      <Button
        variant="secondary"
        size="sm"
        icon={<Download className="h-3.5 w-3.5" aria-hidden="true" />}
        disabled={off}
        loading={busy}
        aria-label={name}
        title={tooltip(single ? name : `${name} (${formats.map((f) => FORMAT_NAME[f]).join(' / ')})`, rowCount, filterSummary)}
        {...(single
          ? { onClick: () => void run(single) }
          : { onClick: () => setMenu((v) => !v), 'aria-expanded': menu, 'aria-controls': menuId })}
      >
        {single ? `Unduh ${FORMAT_NAME[single]}${qualifier ? ` ${qualifier}` : ''}` : (
          <>
            Unduh{qualifier ? ` ${qualifier}` : ''} <ChevronDown className="h-3 w-3" aria-hidden="true" />
          </>
        )}
        {count}
      </Button>
      {!single && menu && (
        <div
          id={menuId}
          className="absolute right-0 top-full z-10 mt-1 min-w-36 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg"
        >
          {formats.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => void run(f)}
              className="w-full px-4 py-2.5 text-left text-xs font-bold text-ink-700 hover:bg-paper-1 focus:bg-paper-1 focus:outline-none"
            >
              {MENU_LABEL[f]}
            </button>
          ))}
        </div>
      )}
      {failure && (
        <p role="alert" className="mt-1 max-w-xs text-right text-xs text-danger">
          {failure}
        </p>
      )}
    </div>
  )
}
