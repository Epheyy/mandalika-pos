import { useEffect, useReducer, useRef } from 'react'
import { AlertTriangle, CheckCircle2, Download, FileUp, Loader2, XCircle } from 'lucide-react'
import { ApiError, type ImportKind, type ImportReport } from '@mandalika/api'
import { api } from '../api'
import { exportToCSV } from '../lib/csvUtils'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Modal'
import {
  KIND_TITLE, appliedMessage, canApply, errorReportRows, hasBlockingErrors, importReducer,
  initialImportState, summaryChips,
} from './importDialogState'

/** A chosen, already-decoded CSV file. */
export interface ImportFile {
  name: string
  csv: string
}

interface ImportDialogProps {
  kind: ImportKind
  file: ImportFile
  onClose: () => void
  /** Called once after a successful apply so the screen can refetch. */
  onApplied: () => void
  /** Ask the host to open the file picker again. */
  onRepick: () => void
}

const ISSUES_SHOWN = 200


const ACTION_LABEL: Record<string, string> = { create: 'Baru', update: 'Diperbarui', skip: 'Dilewati', error: 'Error' }

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Terjadi kesalahan tak terduga.'
}

function reportFromBody(e: unknown): ImportReport | null {
  if (!(e instanceof ApiError) || typeof e.body !== 'object' || e.body === null) return null
  const data = (e.body as { data?: unknown }).data
  return data && typeof data === 'object' && 'summary' in data ? (data as ImportReport) : null
}

export function ImportDialog({ kind, file, onClose, onApplied, onRepick }: ImportDialogProps) {
  const [state, dispatch] = useReducer(importReducer, initialImportState)
  const started = useRef(false)

  const preview = async () => {
    dispatch({ type: 'pick', fileName: file.name, csv: file.csv })
    try {
      const report = await api.importCsv(kind, { csv: file.csv, fileName: file.name, dryRun: true })
      dispatch({ type: 'previewOk', report, key: crypto.randomUUID() })
    } catch (e) {
      dispatch({ type: 'previewFailed', message: errorMessage(e) })
    }
  }

  useEffect(() => {
    if (started.current) return
    started.current = true
    void preview()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per mounted file
  }, [])

  const apply = async () => {
    const { report, key } = state
    if (!canApply(state) || !report || !key) return
    dispatch({ type: 'apply' })
    try {
      const applied = await api.importCsv(
        kind,
        { csv: file.csv, fileName: file.name, dryRun: false, fileSha256: report.fileSha256, expectedSummary: report.summary },
        key,
      )
      dispatch({ type: 'applyOk', report: applied })
      onApplied()
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        dispatch({ type: 'applyStale', message: 'Data berubah sejak pratinjau. Periksa ulang sebelum menerapkan.' })
      } else if (e instanceof ApiError && e.status === 422 && reportFromBody(e)) {
        dispatch({ type: 'applyRejected', report: reportFromBody(e) as ImportReport, message: 'Impor ditolak: tidak ada data yang diubah.' })
      } else {
        dispatch({ type: 'applyFailed', message: `${errorMessage(e)} Coba lagi; kunci yang sama dipakai ulang sehingga tidak ada data ganda.` })
      }
    }
  }

  const { phase, report } = state
  const busy = phase === 'previewing' || phase === 'applying'
  const blocked = report ? hasBlockingErrors(report) : false

  const downloadReport = () => {
    if (!report) return
    exportToCSV(errorReportRows(report), `laporan-impor-${kind}`)
  }

  const footer = (
    <>
      <Button variant="secondary" onClick={onClose} disabled={phase === 'applying'}>
        {phase === 'applied' ? 'Selesai' : 'Batal'}
      </Button>
      {phase !== 'applied' && (
        <>
          <Button variant="secondary" icon={<FileUp className="w-4 h-4" />} onClick={onRepick} disabled={busy}>
            Pilih file lain
          </Button>
          {(phase === 'stale' || phase === 'rejected') && (
            <Button variant="secondary" onClick={() => void preview()} disabled={busy}>
              Pratinjau ulang
            </Button>
          )}
          <Button
            className="ml-auto"
            onClick={() => void apply()}
            disabled={!canApply(state)}
            loading={phase === 'applying'}
          >
            Terapkan
          </Button>
        </>
      )}
    </>
  )

  return (
    <Modal open onClose={onClose} title={KIND_TITLE[kind]} subtitle={file.name} size="2xl" footer={footer}>
      <div className="space-y-4" aria-live="polite">
        {phase === 'previewing' && (
          <p className="flex items-center gap-2 text-sm text-gray-500">
            <Loader2 className="w-4 h-4 animate-spin" /> Memeriksa file…
          </p>
        )}

        {state.message && (
          <p role="alert" className="flex items-start gap-2 rounded-xl bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" /> {state.message}
          </p>
        )}

        {phase === 'applied' && report && (
          <p role="status" className="flex items-start gap-2 rounded-xl bg-green-50 border border-green-200 px-3 py-2 text-sm text-green-800">
            <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" /> Impor berhasil: {appliedMessage(report)}.
          </p>
        )}

        {report && (
          <>
            <div className="flex flex-wrap gap-2" aria-label="Ringkasan">
              {summaryChips(report.summary).map((c) => (
                <span
                  key={c.key}
                  className={`px-3 py-1.5 rounded-xl text-xs font-bold ${
                    c.key === 'error' && c.value > 0
                      ? 'bg-red-100 text-red-700'
                      : c.key === 'warning' && c.value > 0
                        ? 'bg-amber-100 text-amber-700'
                        : 'bg-gray-100 text-gray-700'
                  }`}
                >
                  {c.label}: {c.value}
                </span>
              ))}
              <span className="px-3 py-1.5 rounded-xl text-xs font-bold bg-gray-50 text-gray-500">
                {report.totalRows} baris · pemisah {report.delimiter === '\t' ? 'tab' : `"${report.delimiter}"`}
              </span>
            </div>

            {report.fileIssues.length > 0 && (
              <ul className="space-y-1 text-sm">
                {report.fileIssues.map((f, i) => (
                  <li key={i} className={f.severity === 'error' ? 'text-red-700' : 'text-amber-700'}>
                    {f.severity === 'error' ? <XCircle className="inline w-4 h-4 mr-1" /> : <AlertTriangle className="inline w-4 h-4 mr-1" />}
                    {f.message}
                  </li>
                ))}
              </ul>
            )}

            {report.issues.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-black text-gray-900">Masalah ({report.issues.length})</h3>
                  <Button variant="secondary" size="sm" icon={<Download className="w-3.5 h-3.5" />} onClick={downloadReport}>
                    Unduh laporan error
                  </Button>
                </div>
                <div className="max-h-64 overflow-auto border border-gray-100 rounded-xl">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 text-gray-500 sticky top-0">
                      <tr>
                        <th className="text-left px-3 py-2">Baris</th>
                        <th className="text-left px-3 py-2">Kolom</th>
                        <th className="text-left px-3 py-2">Pesan</th>
                        <th className="text-left px-3 py-2">Nilai</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.issues.slice(0, ISSUES_SHOWN).map((i, n) => (
                        <tr key={n} className="border-t border-gray-50">
                          <td className="px-3 py-1.5 whitespace-nowrap">
                            {i.row} <span className="text-gray-400">(baris file {i.line})</span>
                          </td>
                          <td className="px-3 py-1.5">{i.column ?? ''}</td>
                          <td className={`px-3 py-1.5 ${i.severity === 'error' ? 'text-red-700' : 'text-amber-700'}`}>{i.message}</td>
                          <td className="px-3 py-1.5 text-gray-500 break-all">{i.value ?? ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {report.issues.length > ISSUES_SHOWN && (
                  <p className="text-xs text-gray-400 mt-1">
                    {report.issues.length - ISSUES_SHOWN} masalah lainnya ada di laporan error yang bisa diunduh.
                  </p>
                )}
              </div>
            )}

            {report.rows.length > 0 && (
              <div>
                <h3 className="text-sm font-black text-gray-900 mb-2">
                  Pratinjau baris{report.totalRows > report.rows.length ? ` (${report.rows.length} pertama)` : ''}
                </h3>
                <div className="max-h-56 overflow-auto border border-gray-100 rounded-xl">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 text-gray-500 sticky top-0">
                      <tr>
                        <th className="text-left px-3 py-2">Baris</th>
                        <th className="text-left px-3 py-2">Kunci</th>
                        <th className="text-left px-3 py-2">Hasil</th>
                        <th className="text-left px-3 py-2">Keterangan</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.rows.map((r) => (
                        <tr key={r.row} className="border-t border-gray-50">
                          <td className="px-3 py-1.5">{r.row}</td>
                          <td className="px-3 py-1.5 break-all">{r.key}</td>
                          <td className="px-3 py-1.5 font-bold">{ACTION_LABEL[r.action] ?? r.action}</td>
                          <td className="px-3 py-1.5 text-gray-500">{r.reason ?? ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {blocked && phase !== 'applied' && (
              <p className="text-sm text-red-700">Perbaiki baris yang salah di file lalu pilih file lagi. Terapkan baru aktif jika tidak ada error.</p>
            )}
          </>
        )}

        <p className="text-xs text-gray-400">
          Impor tidak pernah menghapus data atau mengubah stok. Pada baris yang sudah ada, sel kosong berarti nilai lama dipertahankan.
          Simpan file dari Excel sebagai &quot;CSV UTF-8&quot;.
        </p>
      </div>
    </Modal>
  )
}
