import { useRef, useState } from 'react'
import { Upload, FileText } from 'lucide-react'
import type { ImportKind } from '@mandalika/api'
import { Button } from '../ui/Button'
import { ExportButton, type ExportFormat } from '../ui/ExportButton'
import { ImportDialog, type ImportFile } from './ImportDialog'
import { ENCODING_MESSAGE, checkPickedFile, decodeUtf8 } from './importDialogState'

export interface ImportExportBarProps {
  /** Build + trigger the export. Caller maps its data to rows then calls exportToCSV/exportToXLSX. */
  onExport: (fmt: ExportFormat) => Promise<void> | void
  exportDisabled?: boolean
  /** Plain-words filters the export honours ("Status: Aktif"); shown in the button's tooltip. */
  filterSummary?: readonly string[]
  /** Which server-side CSV import this bar drives (A39). Omit to render export-only. */
  importKind?: ImportKind
  /** Called after a successful import so the screen can refetch its lists. */
  onImported?: () => void
  onTemplate?: () => void
}

export function ImportExportBar({
  onExport,
  exportDisabled,
  filterSummary = [],
  importKind,
  onImported,
  onTemplate,
}: ImportExportBarProps) {
  const [picked, setPicked] = useState<(ImportFile & { id: number }) | null>(null)
  const [pickError, setPickError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const nextId = useRef(0)

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
        <ExportButton
          formats={['csv', 'xlsx']}
          rowCount={null}
          filterSummary={filterSummary}
          disabled={exportDisabled}
          onExport={onExport}
        />

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
                Templat
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
