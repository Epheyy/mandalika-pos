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
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div className="w-full max-w-md bg-white h-full flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <h2 className="font-bold text-gray-900">Riwayat Transfer</h2>
          <button type="button" onClick={onClose} className="text-gray-400 text-xl leading-none">×</button>
        </div>
        <div className="flex border-b">
          {(['completed', 'cancelled'] as Tab[]).map((t) => (
            <button type="button" key={t} onClick={() => setTab(t)}
              className={`flex-1 py-2.5 text-sm font-bold ${tab === t ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-gray-400'}`}>
              {t === 'completed' ? 'Selesai' : 'Dibatalkan'}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-auto">
          {loading ? <p className="p-4 text-sm text-gray-400">Memuat…</p>
            : err ? <p className="p-4 text-sm text-red-600">{err}</p>
            : rows.length === 0 ? <p className="p-4 text-sm text-gray-400">Tidak ada transfer.</p>
            : rows.map((t) => (
              <button type="button" key={t.id} onClick={() => setOpen(t)}
                className="w-full text-left px-4 py-3 border-b hover:bg-gray-50">
                <div className="flex justify-between">
                  <span className="font-bold text-gray-800 text-sm">{t.transferNo}</span>
                  <span className="text-xs text-gray-400">{fmtDate(t.receivedAt ?? t.createdAt)}</span>
                </div>
                <div className="text-xs text-gray-500">{t.source?.name} → {t.dest?.name} · {t.items?.length ?? 0} item</div>
                {t.discrepancyReason && <div className="text-xs text-amber-600">Selisih: {t.discrepancyReason}</div>}
              </button>
            ))}
        </div>
        {open && (
          <div className="border-t bg-gray-50 max-h-[45%] overflow-auto p-4">
            <div className="flex justify-between items-center mb-2">
              <span className="font-bold text-sm">{open.transferNo}</span>
              <button type="button" className="text-gray-400 text-sm" onClick={() => setOpen(null)}>Tutup detail</button>
            </div>
            <div className="text-xs text-gray-600 mb-2">{open.source?.name} → {open.dest?.name}</div>
            {(open.items ?? []).map((it) => (
              <div key={`${it.productId}-${it.variantSize}`} className="flex justify-between text-xs py-0.5">
                <span>{it.productName} {it.variantSize}</span>
                <span>{it.sentQty}{it.receivedQty != null && it.receivedQty !== it.sentQty ? ` → ${it.receivedQty}` : ''}</span>
              </div>
            ))}
            {open.status === 'completed' && (
              <button type="button" onClick={() => onReprint(open)}
                className="mt-3 w-full bg-indigo-600 text-white rounded-lg py-2 text-sm font-bold">
                Cetak Ulang Tanda Terima
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
