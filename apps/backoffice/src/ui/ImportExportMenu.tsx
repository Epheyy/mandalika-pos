import { useId, useRef, useState, type ChangeEvent } from 'react'
import { ChevronDown, Download, FileSpreadsheet, FileText, Upload } from 'lucide-react'
import type { ImportKind } from '@mandalika/api'
import { ImportDialog, type ImportFile } from '../components/ImportDialog'
import { ENCODING_MESSAGE, checkPickedFile, decodeUtf8 } from '../components/importDialogState'
import { useDismiss } from '../shell/useDismiss'
import { Button } from './Button'
import type { ExportFormat } from './ExportButton'

export interface ImportExportMenuProps {
  /** Build and trigger the export. Omit for an import-only menu. */
  onExport?: (format: ExportFormat) => Promise<void> | void
  exportDisabled?: boolean
  /** Which server-side CSV import this menu drives. Omit for export-only. */
  importKind?: ImportKind
  /** Called after a successful import so the screen can refetch. */
  onImported?: () => void
  /** Adds "Unduh templat" when an import kind is set. */
  onTemplate?: () => void
}

const ITEM =
  'flex h-10 w-full items-center gap-2 px-4 text-left text-[13px] font-bold text-ink-700 hover:bg-paper-1 focus:bg-paper-1 ' +
  'focus:outline-none disabled:cursor-not-allowed disabled:opacity-50'

/**
 * The one "Impor / Ekspor" header control (D-99): a disclosure button that opens a short list of plain buttons.
 * It takes the same props as the older ImportExportBar, so a screen swaps one for the other without touching its
 * handlers. The file input keeps the name "Impor dari file CSV" and the dialog is the existing ImportDialog.
 * Deliberately not role="menu" (that would need full arrow-key handling); Tab walks the items.
 */
export function ImportExportMenu({ onExport, exportDisabled, importKind, onImported, onTemplate }: ImportExportMenuProps) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [picked, setPicked] = useState<(ImportFile & { id: number }) | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const nextId = useRef(0)
  const listId = useId()
  useDismiss(open, () => setOpen(false), root)

  const runExport = async (format: ExportFormat) => {
    setOpen(false)
    setFailure(null)
    setBusy(true)
    try {
      await onExport?.(format)
    } catch (e) {
      setFailure(e instanceof Error && e.message ? e.message : 'Unduhan gagal. Coba lagi.')
    } finally {
      setBusy(false)
    }
  }

  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setFailure(null)
    const problem = checkPickedFile(file.name, file.size)
    if (problem) {
      setFailure(problem)
      return
    }
    // Strict UTF-8: an ANSI "CSV" is refused, not silently mangled (the server checks again).
    const csv = decodeUtf8(await file.arrayBuffer())
    if (csv === null) {
      setFailure(ENCODING_MESSAGE)
      return
    }
    setPicked({ id: ++nextId.current, name: file.name, csv })
  }

  const hasImport = importKind !== undefined
  if (!onExport && !hasImport) return null

  return (
    <div className="relative inline-flex flex-col items-end" ref={root}>
      <Button
        variant="secondary"
        icon={<Download className="h-4 w-4" aria-hidden="true" />}
        loading={busy}
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
      >
        {hasImport && onExport ? 'Impor / Ekspor' : hasImport ? 'Impor' : 'Ekspor'}
        <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
      {open && (
        <div id={listId} className="surface-solid absolute right-0 top-full z-20 mt-1 min-w-48 overflow-hidden rounded-xl py-1">
          {onExport && (
            <>
              <button type="button" className={ITEM} disabled={exportDisabled} onClick={() => void runExport('csv')}>
                <FileText className="h-4 w-4" aria-hidden="true" /> Ekspor CSV
              </button>
              <button type="button" className={ITEM} disabled={exportDisabled} onClick={() => void runExport('xlsx')}>
                <FileSpreadsheet className="h-4 w-4" aria-hidden="true" /> Ekspor Excel
              </button>
            </>
          )}
          {hasImport && (
            <>
              <button
                type="button"
                className={ITEM}
                onClick={() => {
                  setOpen(false)
                  fileRef.current?.click()
                }}
              >
                <Upload className="h-4 w-4" aria-hidden="true" /> Impor CSV…
              </button>
              {onTemplate && (
                <button
                  type="button"
                  className={ITEM}
                  onClick={() => {
                    setOpen(false)
                    onTemplate()
                  }}
                >
                  <Download className="h-4 w-4" aria-hidden="true" /> Unduh templat
                </button>
              )}
            </>
          )}
        </div>
      )}
      {hasImport && (
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => void handleFile(e)}
          aria-label="Impor dari file CSV"
          className="hidden"
        />
      )}
      {failure && (
        <p role="alert" className="mt-1 max-w-xs text-right text-xs text-danger">
          {failure}
        </p>
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
