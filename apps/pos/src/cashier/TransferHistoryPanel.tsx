/**
 * Outlet transfer history — completed / cancelled transfers for this outlet.
 * Two tabs (Selesai / Dibatalkan) backed by api.outletTransfers(status).
 * Tapping a row expands an inline detail with per-line sent/received qty; a
 * completed transfer offers "Cetak Ulang Tanda Terima" which calls onReprint —
 * the parent (CashierScreen) owns the printer + paired guard and stamps the
 * REPRINT marker. Network is required to load (no offline cache here).
 */
import { useEffect, useState } from 'react'
import type { Transfer } from '@mandalika/api'
import { api } from '../api'
import { Sheet } from '../components/ui/Sheet'
import { Button } from '../components/ui/Button'

type Tab = 'completed' | 'cancelled'

interface Props {
  onClose: () => void
  onReprint: (t: Transfer) => void
}

const fmtDate = (iso?: string | null): string => {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('id-ID', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return iso
  }
}

export function TransferHistoryPanel({ onClose, onReprint }: Props) {
  const [tab, setTab] = useState<Tab>('completed')
  const [rows, setRows] = useState<Transfer[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState<Transfer | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true); setErr(null); setOpen(null)
    api.outletTransfers(tab)
      .then((r) => { if (alive) setRows(r) })
      .catch(() => { if (alive) setErr('Perlu koneksi untuk memuat riwayat transfer.') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [tab])

  return (
    <Sheet open variant="side" maxWidth="max-w-md" onClose={onClose} header title="Riwayat Transfer" panelClassName="flex flex-col">
        <div className="flex border-b border-paper-2">
          {(['completed', 'cancelled'] as Tab[]).map((t) => (
            <button type="button" key={t} onClick={() => setTab(t)}
              className={`press min-h-11 flex-1 py-2.5 text-sm font-bold ${tab === t ? 'border-b-2 border-brand-strong text-brand-strong' : 'text-ink-700'}`}>
              {t === 'completed' ? 'Selesai' : 'Dibatalkan'}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {loading ? <p className="p-4 text-sm text-ink-500">Memuat…</p>
            : err ? <p className="p-4 text-sm text-danger">{err}</p>
            : rows.length === 0 ? <p className="p-4 text-sm text-ink-500">Tidak ada transfer.</p>
            : rows.map((t) => (
              <button type="button" key={t.id} onClick={() => setOpen(t)}
                className="w-full min-h-11 border-b border-paper-2 px-4 py-3 text-left active:bg-paper-1">
                <div className="flex justify-between">
                  <span className="text-sm font-bold text-ink-900">{t.transferNo}</span>
                  <span className="tnum text-xs text-ink-500">{fmtDate(t.receivedAt ?? t.createdAt)}</span>
                </div>
                <div className="text-xs text-ink-700">{t.source?.name} → {t.dest?.name} · {t.items?.length ?? 0} item</div>
                {t.discrepancyReason && <div className="text-xs text-warn-strong">Selisih: {t.discrepancyReason}</div>}
              </button>
            ))}
        </div>
        {open && (
          <div className="surface-group rounded-bl-panel max-h-[45%] overflow-auto border-t border-paper-2 p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-bold text-ink-900">{open.transferNo}</span>
              <button type="button" className="press min-h-11 px-2 text-sm font-semibold text-ink-700" onClick={() => setOpen(null)}>Tutup detail</button>
            </div>
            <div className="mb-2 text-xs text-ink-700">{open.source?.name} → {open.dest?.name}</div>
            {(open.items ?? []).map((it) => (
              <div key={`${it.productId}-${it.variantSize}`} className="tnum flex justify-between py-0.5 text-xs text-ink-900">
                <span>{it.productName} {it.variantSize}</span>
                <span>{it.sentQty}{it.receivedQty != null && it.receivedQty !== it.sentQty ? ` → ${it.receivedQty}` : ''}</span>
              </div>
            ))}
            {open.status === 'completed' && (
              <Button variant="secondary" fullWidth onClick={() => onReprint(open)} className="mt-3">
                Cetak Ulang Tanda Terima
              </Button>
            )}
          </div>
        )}
    </Sheet>
  )
}
