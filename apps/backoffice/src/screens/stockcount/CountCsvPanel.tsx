import { useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Download, FileUp, Loader2 } from 'lucide-react'
import { ApiError, type StockCount, type StockCountImportReport } from '@mandalika/api'
import { api, authStore } from '../../api'
import { withCountScope } from './countScope'
import { Button } from '../../ui/Button'
import { Modal } from '../../ui/Modal'
import { canApplyCount, reportFromErrorBody, rowWarnings, summaryChips } from './countCsvState'

interface CountCsvPanelProps {
  count: StockCount
  /** Called once after a successful apply so the screen can drop unsaved edits and refetch. */
  onApplied: () => void
  /** Unsaved line edits exist: an upload would replace them silently, so it waits for "Simpan". */
  blocked?: boolean
}

type Phase = 'idle' | 'previewing' | 'ready' | 'applying' | 'applied'

const ROWS_SHOWN = 200
const UNCOUNTED_SHOWN = 100

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Terjadi kesalahan tak terduga.'
}

function downloadText(text: string, fileName: string) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8;' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = fileName
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

/**
 * Scanner CSV for one running count: download the sheet, upload the scanned result, review the
 * diff, then apply. Applying stores counted quantities only (never stock); the normal
 * "Ajukan Persetujuan" / "Selesai" step follows.
 */
export function CountCsvPanel({ count, onApplied, blocked = false }: CountCsvPanelProps) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [file, setFile] = useState<{ name: string; csv: string } | null>(null)
  const [report, setReport] = useState<StockCountImportReport | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  // One Idempotency-Key per file content: kept across failed applies so a retry cannot double-apply.
  const key = useRef('')
  const busy = phase === 'previewing' || phase === 'applying'

  const download = async () => {
    setMessage(null)
    try {
      downloadText(await withCountScope(authStore, count, () => api.exportStockCount(count.id)), `stock-count-${count.name.replace(/[^a-z0-9]+/gi, '-')}.csv`)
    } catch (e) {
      setMessage(errorMessage(e))
    }
  }

  const runPreview = async (f: { name: string; csv: string }) => {
    setPhase('previewing')
    setMessage(null)
    try {
      setReport(await withCountScope(authStore, count, () => api.importStockCount(count.id, { csv: f.csv, fileName: f.name, dryRun: true })))
      setPhase('ready')
    } catch (e) {
      setReport(null)
      setMessage(errorMessage(e))
      setPhase('ready')
    }
  }

  const pick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const chosen = e.target.files?.[0]
    e.target.value = ''
    if (!chosen) return
    const next = { name: chosen.name, csv: await chosen.text() }
    key.current = crypto.randomUUID()
    setFile(next)
    setReport(null)
    await runPreview(next)
  }

  const apply = async () => {
    if (!file || !report || blocked || !canApplyCount(report, busy)) return
    setPhase('applying')
    setMessage(null)
    try {
      const applied = await withCountScope(authStore, count, () => api.importStockCount(
        count.id,
        { csv: file.csv, fileName: file.name, dryRun: false, fileSha256: report.fileSha256, expectedSummary: report.summary },
        key.current,
      ))
      setReport(applied)
      setPhase('applied')
      onApplied()
    } catch (e) {
      setPhase('ready')
      if (e instanceof ApiError && e.status === 409) {
        const code = (e.body as { data?: { code?: string } } | null)?.data?.code
        if (code === 'import_stale') {
          setMessage('Data berubah sejak pratinjau (hitungan atau stok bergerak). Pratinjau ulang sebelum menerapkan.')
          key.current = crypto.randomUUID() // the old key belongs to the old preview
        } else if (code === 'idempotency_conflict') {
          setMessage('Kunci unggahan ini sudah dipakai untuk file lain. Pilih file lagi.')
        } else {
          setMessage(errorMessage(e)) // e.g. the count is no longer in progress
        }
      } else if (e instanceof ApiError && e.status === 422 && reportFromErrorBody(e.body)) {
        setReport(reportFromErrorBody(e.body))
        setMessage('Impor ditolak: tidak ada data yang diubah.')
      } else {
        setMessage(`${errorMessage(e)} Coba lagi; kunci yang sama dipakai ulang sehingga tidak ada data ganda.`)
      }
    }
  }

  const close = () => {
    if (phase === 'applying') return
    setFile(null)
    setReport(null)
    setMessage(null)
    setPhase('idle')
  }

  const open = phase !== 'idle'
  return (
    <>
      <input ref={fileInput} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => void pick(e)} aria-label="File hasil scan (CSV)" />
      <Button variant="secondary" size="sm" icon={<Download className="w-3 h-3" />} onClick={() => void download()}>
        Unduh CSV
      </Button>
      <Button variant="secondary" size="sm" icon={<FileUp className="w-3 h-3" />} disabled={blocked} onClick={() => fileInput.current?.click()}>
        Unggah Hasil Scan
      </Button>
      {blocked && <span className="text-xs text-amber-700">Simpan dulu hitungan yang belum tersimpan.</span>}
      {message && phase === 'idle' && (
        <span role="alert" className="text-xs font-bold text-red-700">{message}</span>
      )}
      {open && (
        <Modal
          open
          onClose={close}
          title="Hasil Scan"
          subtitle={file?.name}
          size="2xl"
          footer={
            <>
              <Button variant="secondary" onClick={close} disabled={phase === 'applying'}>
                {phase === 'applied' ? 'Selesai' : 'Batal'}
              </Button>
              {phase !== 'applied' && (
                <>
                  <Button variant="secondary" icon={<FileUp className="w-4 h-4" />} onClick={() => fileInput.current?.click()} disabled={busy}>
                    Pilih file lain
                  </Button>
                  {file && (
                    <Button variant="secondary" onClick={() => void runPreview(file)} disabled={busy}>
                      Pratinjau ulang
                    </Button>
                  )}
                  <Button className="ml-auto" onClick={() => void apply()} disabled={blocked || !canApplyCount(report, busy)} loading={phase === 'applying'}>
                    Terapkan
                  </Button>
                </>
              )}
            </>
          }
        >
          <PreviewBody phase={phase} report={report} message={message} />
        </Modal>
      )}
    </>
  )
}

function PreviewBody({ phase, report, message }: { phase: Phase; report: StockCountImportReport | null; message: string | null }) {
  return (
    <div className="space-y-4" aria-live="polite">
      {phase === 'previewing' && (
        <p className="flex items-center gap-2 text-sm text-gray-500">
          <Loader2 className="w-4 h-4 animate-spin" /> Memeriksa file…
        </p>
      )}
      {message && (
        <p role="alert" className="flex items-start gap-2 rounded-xl bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" /> {message}
        </p>
      )}
      {phase === 'applied' && report && (
        <p role="status" className="flex items-start gap-2 rounded-xl bg-green-50 border border-green-200 px-3 py-2 text-sm text-green-800">
          <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" /> {report.summary.changed} baris tersimpan. Stok tidak berubah. Lanjutkan dengan
          &quot;Ajukan Persetujuan&quot; / &quot;Selesai&quot;.
        </p>
      )}
      {report && <ReportTables report={report} />}
      <p className="text-xs text-gray-400">
        Unggahan hanya menyimpan jumlah hitung; stok baru berubah saat opname disetujui/selesai. Kode yang sama dijumlahkan. Barcode didahulukan
        dari SKU. Simpan file sebagai &quot;CSV UTF-8&quot;.
      </p>
    </div>
  )
}

function ReportTables({ report }: { report: StockCountImportReport }) {
  const errors = report.issues.filter((i) => i.severity === 'error')
  return (
    <>
      <div className="flex flex-wrap gap-2" aria-label="Ringkasan">
        {summaryChips(report).map((c) => (
          <span key={c.key} className={`px-3 py-1.5 rounded-xl text-xs font-bold ${c.bad ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-700'}`}>
            {c.label}: {c.value}
          </span>
        ))}
      </div>
      {report.fileIssues.map((f, i) => (
        <p key={i} className={`text-sm ${f.severity === 'error' ? 'text-red-700' : 'text-amber-700'}`}>{f.message}</p>
      ))}
      {errors.length > 0 && (
        <ul className="text-sm text-red-700 space-y-1">
          {errors.slice(0, 20).map((i, n) => (
            <li key={n}>Baris {i.row}: {i.message}{i.value ? ` (${i.value})` : ''}</li>
          ))}
          <li className="text-xs text-gray-500">Perbaiki file lalu pilih file lagi. Terapkan baru aktif jika tidak ada error.</li>
        </ul>
      )}
      {report.rows.length > 0 && (
        <div className="max-h-64 overflow-auto border border-gray-100 rounded-xl">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-500 sticky top-0">
              <tr>
                {['Kode', 'Produk', 'Sistem', 'Hitung', 'Selisih', 'Sebelumnya', 'Catatan'].map((h) => (
                  <th key={h} className="text-left px-3 py-2">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.rows.slice(0, ROWS_SHOWN).map((r) => (
                <tr key={r.row} className="border-t border-gray-50">
                  <td className="px-3 py-1.5 font-mono break-all">{r.code}</td>
                  <td className="px-3 py-1.5">{r.matchedLine ? `${r.matchedLine.productName ?? ''} ${r.matchedLine.variantSize}` : ''}</td>
                  <td className="px-3 py-1.5">{r.expected ?? ''}</td>
                  <td className="px-3 py-1.5 font-bold">{r.counted}</td>
                  <td className={`px-3 py-1.5 font-bold ${r.difference ? 'text-red-700' : ''}`}>{r.difference ?? ''}</td>
                  <td className="px-3 py-1.5 text-gray-500">{r.previous ?? ''}</td>
                  <td className="px-3 py-1.5 text-amber-700">{rowWarnings(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {report.uncounted.length > 0 && (
        <div>
          <h3 className="text-sm font-black text-gray-900 mb-1">Belum dihitung ({report.summary.uncounted})</h3>
          <p className="text-xs text-gray-600">
            {report.uncounted.slice(0, UNCOUNTED_SHOWN).map((u) => `${u.productName ?? u.sku ?? ''} ${u.variantSize}`).join(', ')}
            {report.summary.uncounted > UNCOUNTED_SHOWN ? ` … dan ${report.summary.uncounted - UNCOUNTED_SHOWN} lainnya` : ''}
          </p>
        </div>
      )}
    </>
  )
}
