import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Download, Upload, FileText } from 'lucide-react'
import type { ImportKind } from '@mandalika/api'
import { Button } from '../ui/Button'
import { ImportDialog, type ImportFile } from './ImportDialog'
import { ENCODING_MESSAGE, checkPickedFile, decodeUtf8 } from './importDialogState'

export interface ImportExportBarProps {
  /** Build + trigger the export. Caller maps its data to rows then calls exportToCSV/exportToXLSX. */
  onExport: (fmt: 'csv' | 'xlsx') => void
  exportDisabled?: boolean
  /** Which server-side CSV import this bar drives (A39). Omit to render export-only. */
  importKind?: ImportKind
  /** Called after a successful import so the screen can refetch its lists. */
  onImported?: () => void
  onTemplate?: () => void
}

export function ImportExportBar({
  onExport,
  exportDisabled,
  importKind,
  onImported,
  onTemplate,
}: ImportExportBarProps) {
  const [exportMenu, setExportMenu] = useState(false)
  const [picked, setPicked] = useState<(ImportFile & { id: number }) | null>(null)
  const [pickError, setPickError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const nextId = useRef(0)

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
    e.target.value = ''
    if (!file) return
    setPickError(null)
    const problem = checkPickedFile(file.name, file.size)
    if (problem) {
      setPickError(problem)
      return
    }
    // Strict UTF-8: an ANSI "CSV" must be refused, not silently mangled (the server checks again).
    const csv = decodeUtf8(await file.arrayBuffer())
    if (csv === null) {
      setPickError(ENCODING_MESSAGE)
      return
    }
    setPicked({ id: ++nextId.current, name: file.name, csv })
  }

  const hasImport = importKind !== undefined

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
              <button type="button"
                onClick={() => handleExport('csv')}
                className="w-full text-left px-4 py-2.5 text-xs font-bold hover:bg-gray-50 text-gray-700"
              >
                CSV (.csv)
              </button>
              <button type="button"
                onClick={() => handleExport('xlsx')}
                className="w-full text-left px-4 py-2.5 text-xs font-bold hover:bg-gray-50 text-gray-700"
              >
                Excel (.xlsx)
              </button>
            </div>
          )}
        </div>

        {/* Template + Import (only when an import kind is provided) */}
        {hasImport && (
          <>
            {onTemplate && (
              <Button
                variant="secondary"
                size="sm"
                icon={<FileText className="w-3.5 h-3.5" />}
                onClick={onTemplate}
              >
                Template
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              icon={<Upload className="w-3.5 h-3.5" />}
              onClick={() => fileRef.current?.click()}
            >
              Import
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => void handleFile(e)}
              aria-label="Impor dari file CSV"
              className="hidden"
            />
          </>
        )}
      </div>

      {pickError && (
        <p role="alert" className="text-xs text-red-600 mt-0.5 max-w-xs text-right">{pickError}</p>
      )}

      {hasImport && picked && (
        <ImportDialog
          key={picked.id}
          kind={importKind}
          file={picked}
          onClose={() => setPicked(null)}
          onApplied={() => onImported?.()}
          onRepick={() => {
            setPicked(null)
            fileRef.current?.click()
          }}
        />
      )}
    </div>
  )
}
