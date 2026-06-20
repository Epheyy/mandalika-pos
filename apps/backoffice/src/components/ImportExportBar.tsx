import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Download, Upload, FileText } from 'lucide-react'
import { Button } from '../ui/Button'
import { parseCSV } from '../lib/csvUtils'

export interface ImportExportBarProps {
  /** Build + trigger the export. Caller maps its data to rows then calls exportToCSV/exportToXLSX. */
  onExport: (fmt: 'csv' | 'xlsx') => void
  exportDisabled?: boolean
  /** Provide all three to enable import; omit to render export-only. */
  onImport?: (rows: Record<string, string>[]) => Promise<void> | void
  onTemplate?: () => void
  /** Optional: shown as a small result/error line under the bar after import. */
  importMessage?: string | null
}

export function ImportExportBar({
  onExport,
  exportDisabled,
  onImport,
  onTemplate,
  importMessage,
}: ImportExportBarProps) {
  const [exportMenu, setExportMenu] = useState(false)
  const [importing, setImporting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close the export dropdown when clicking outside
  useEffect(() => {
    if (!exportMenu) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setExportMenu(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [exportMenu])

  const handleExport = (fmt: 'csv' | 'xlsx') => {
    onExport(fmt)
    setExportMenu(false)
  }

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !onImport) return
    setImporting(true)
    try {
      const text = await file.text()
      const rows = parseCSV(text)
      await onImport(rows)
    } finally {
      setImporting(false)
      e.target.value = ''
    }
  }

  const hasImport = typeof onImport === 'function'

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {/* Export dropdown */}
        <div className="relative" ref={menuRef}>
          <Button
            variant="secondary"
            size="sm"
            icon={<Download className="w-3.5 h-3.5" />}
            disabled={exportDisabled}
            onClick={() => setExportMenu((v) => !v)}
          >
            Export <ChevronDown className="w-3 h-3" />
          </Button>
          {exportMenu && (
            <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg z-10 min-w-32 overflow-hidden">
              <button
                onClick={() => handleExport('csv')}
                className="w-full text-left px-4 py-2.5 text-xs font-bold hover:bg-gray-50 text-gray-700"
              >
                CSV (.csv)
              </button>
              <button
                onClick={() => handleExport('xlsx')}
                className="w-full text-left px-4 py-2.5 text-xs font-bold hover:bg-gray-50 text-gray-700"
              >
                Excel (.xlsx)
              </button>
            </div>
          )}
        </div>

        {/* Template + Import (only when onImport is provided) */}
        {hasImport && (
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={<FileText className="w-3.5 h-3.5" />}
              onClick={onTemplate}
            >
              Template
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Upload className="w-3.5 h-3.5" />}
              disabled={importing}
              onClick={() => fileRef.current?.click()}
            >
              {importing ? 'Mengimpor…' : 'Import'}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv"
              onChange={handleFile}
              aria-label="Impor dari file CSV"
              className="hidden"
            />
          </>
        )}
      </div>

      {/* Import result / error message */}
      {importMessage && (
        <p className="text-xs text-gray-500 mt-0.5">{importMessage}</p>
      )}
    </div>
  )
}
