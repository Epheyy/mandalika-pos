import type { ReactNode } from 'react'
import { api } from '../../api'
import { BRAND } from '../../lib/brand'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { Button } from '../../ui/Button'
import { Modal } from '../../ui/Modal'
import { formatMovementTime } from './stockCardFormat'
import type { DocRef } from './documentRef'

const TITLE: Record<DocRef['type'], string> = {
  adjustment: 'Pengajuan Penyesuaian',
  transfer: 'Transfer',
  count: 'Opname',
  receipt: 'Barang Masuk',
  order: 'Transaksi',
  refund: 'Refund',
}

// A document does not change under the reader: no polling.
const NO_POLL_MS = 3_600_000

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 text-sm">
      <span className="text-gray-400">{k}</span>
      <span className="font-bold text-gray-900 text-right">{v}</span>
    </div>
  )
}

interface Line {
  key: string
  name: string
  size: string
  qty: ReactNode
}

function Lines({ heads, lines }: { heads: [string, string, string]; lines: Line[] }) {
  return (
    <div className="max-h-64 overflow-y-auto">
      <table className="w-full">
        <thead className="bg-gray-50 sticky top-0">
          <tr>{heads.map((h) => <th key={h} className="text-left px-3 py-1.5 text-xs font-black text-gray-400 uppercase">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {lines.map((l) => (
            <tr key={l.key}>
              <td className="px-3 py-1.5 text-sm font-bold text-gray-900">{l.name}</td>
              <td className="px-3 py-1.5 text-xs text-gray-600">{l.size}</td>
              <td className="px-3 py-1.5 text-sm">{l.qty}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const when = (iso: string | null | undefined, zone: string) => (iso ? formatMovementTime(iso, zone) : '-')

/** The body of a document, fetched by type. Read-only: the documents are never edited here. */
function useDocumentBody(doc: DocRef, zone: string) {
  return usePolledQuery<ReactNode>(async () => {
    switch (doc.type) {
      case 'adjustment': {
        const r = await api.getAdjustmentRequest(doc.id)
        return (
          <div className="space-y-2">
            <Row k="Nomor" v={r.number} />
            <Row k="Status" v={r.status} />
            <Row k="Produk" v={`${r.productName ?? r.productId} · ${r.variantSize}`} />
            <Row k="Stok saat diajukan" v={r.qtyAtRequest} />
            <Row k="Jumlah baru diminta" v={r.requestedNewQty} />
            <Row k="Alasan" v={`${r.reasonCode}${r.reasonText ? `: ${r.reasonText}` : ''}`} />
            <Row k="Diajukan oleh" v={`${r.requestedByName ?? '-'} · ${when(r.requestedAt, zone)}`} />
            {r.approvedAt && <Row k="Disetujui oleh" v={`${r.approvedByName ?? '-'} · ${when(r.approvedAt, zone)}`} />}
            {r.decisionNote && <Row k="Catatan keputusan" v={r.decisionNote} />}
          </div>
        )
      }
      case 'transfer': {
        const t = await api.getTransfer(doc.id)
        return (
          <div className="space-y-2">
            <Row k="Nomor" v={t.transferNo} />
            <Row k="Status" v={t.status} />
            <Row k="Dari → Ke" v={`${t.source.name ?? t.source.kind} → ${t.dest.name ?? t.dest.kind}`} />
            <Row k="Dikirim" v={when(t.sentAt, zone)} />
            <Row k="Diterima" v={when(t.receivedAt, zone)} />
            {t.discrepancyReason && <Row k="Selisih" v={t.discrepancyReason} />}
            <Lines
              heads={['Produk', 'Ukuran', 'Kirim / Terima']}
              lines={t.items.map((i) => ({ key: `${i.productId}|${i.variantSize}`, name: i.productName, size: i.variantSize, qty: `${i.sentQty} / ${i.receivedQty ?? '-'}` }))}
            />
          </div>
        )
      }
      case 'count': {
        const c = await api.getStockCount(doc.id)
        return (
          <div className="space-y-2">
            <Row k="Nama" v={c.name} />
            <Row k="Status" v={c.status} />
            {c.approvedAt && <Row k="Disetujui oleh" v={`${c.approvedByName ?? '-'} · ${when(c.approvedAt, zone)}`} />}
            <Lines
              heads={['Produk', 'Ukuran', 'Sistem / Aktual']}
              lines={c.items.map((i) => ({ key: `${i.productId}|${i.variantSize}`, name: i.productName, size: i.variantSize, qty: `${i.baselineQty ?? i.frozenQty} / ${i.actualQty ?? '-'}` }))}
            />
          </div>
        )
      }
      case 'receipt': {
        const g = await api.getGoodsReceipt(doc.id)
        return (
          <div className="space-y-2">
            <Row k="Lokasi" v={g.locationName ?? g.locationType} />
            <Row k="Jenis" v={g.source === 'warranty' ? 'Penggantian garansi' : 'Barang masuk'} />
            {g.supplier && <Row k="Pemasok" v={g.supplier} />}
            {g.note && <Row k="Catatan" v={g.note} />}
            <Row k="Dicatat oleh" v={`${g.createdByName ?? '-'} · ${when(g.createdAt, zone)}`} />
            <Lines
              heads={['Produk', 'Ukuran', 'Qty']}
              lines={g.items.map((i) => ({ key: `${i.productId}|${i.variantSize}`, name: i.productName, size: i.variantSize, qty: i.qty }))}
            />
          </div>
        )
      }
      case 'refund': {
        const o = await api.getOrder(doc.id)
        const refunds = o.refunds ?? []
        // No seq = the server could not resolve which refund: never guess the latest one.
        const r = doc.seq ? refunds.find((x) => x.seq === doc.seq) : undefined
        return (
          <div className="space-y-2">
            <Row k="Struk" v={o.orderNumber} />
            {r ? (
              <>
                <Row k="Refund" v={`ke-${r.seq}`} />
                <Row k="Jumlah" v={BRAND.currency.format(r.amount)} />
                <Row k="Alasan" v={r.reason || '-'} />
                <Row k="Oleh" v={`${r.refundedByName ?? '-'} · ${when(r.refundedAt, zone)}`} />
              </>
            ) : (
              <>
                <p className="text-sm text-gray-400">Refund mana yang dimaksud baris ini tidak dapat dipastikan; berikut ringkasan refund transaksi.</p>
                <Row k="Jumlah refund" v={`${refunds.length}×`} />
                <Row k="Total direfund" v={BRAND.currency.format(o.refundedAmount ?? refunds.reduce((s, x) => s + x.amount, 0))} />
              </>
            )}
          </div>
        )
      }
      case 'order': {
        const o = await api.getOrder(doc.id)
        return (
          <div className="space-y-2">
            <Row k="Nomor" v={o.orderNumber} />
            <Row k="Status" v={o.status} />
            <Row k="Kasir" v={o.cashierName} />
            <Row k="Waktu" v={when(o.createdAt, zone)} />
            <Row k="Total" v={o.total.toLocaleString('id-ID')} />
          </div>
        )
      }
    }
  }, [doc.type, doc.id, doc.type === 'refund' ? doc.seq : null], NO_POLL_MS)
}

interface DocumentModalProps {
  doc: DocRef
  zone: string
  onClose: () => void
}

export function DocumentModal({ doc, zone, onClose }: DocumentModalProps) {
  const body = useDocumentBody(doc, zone)
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={TITLE[doc.type]}
      subtitle={doc.label}
      footer={<Button variant="secondary" className="flex-1" onClick={onClose}>Tutup</Button>}
    >
      {body.error ? <p role="alert" className="text-sm text-red-600">{body.error}</p> : body.loading ? <p className="text-sm text-gray-400">Memuat…</p> : body.data}
    </Modal>
  )
}
