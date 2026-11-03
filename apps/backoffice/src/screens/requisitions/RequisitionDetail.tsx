import { useRef, useState } from 'react'
import type { StockRequisition } from '@mandalika/api'
import { variantLabel } from '@mandalika/types'
import { ArrowLeft, Ban, Check, ExternalLink, Pencil, Send, Truck, X } from 'lucide-react'
import { api } from '../../api'
import { useAuth } from '../../auth'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { navigate } from '../../lib/router/navigate'
import { useOutlet } from '../../outlet'
import { TableSkeleton } from '../../components/Skeleton'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { Select, Textarea, fieldClass } from '../../ui/Field'
import { useConfirm } from '../../ui/ConfirmDialog'
import { PageHeader } from '../../ui/PageHeader'
import { StatusBadge } from '../../ui/StatusBadge'
import { TRANSFER_STATUS } from '../../lib/labels/transfer'
import { requisitionConfirm, type RequisitionAction } from './requisitionConfirm'
import { transferHash } from '../transfers/transferRoute'
import {
  EVENT_LABEL, REQUISITION_CHAIN, REQUISITION_STATUS,
  canRefulfil, chainIndex, fmtDate, fmtDateTime,
} from './requisitionStatus'

interface RequisitionDetailProps {
  id: string
  onBack: () => void
  onEdit: (pb: StockRequisition) => void
}

/** Open the linked transfer on Inventori > Transfer. */
function openTransfer(transferId: string): void {
  void navigate(transferHash({ kind: 'detail', id: transferId }))
}

function StatusChain({ status }: { status: StockRequisition['status'] }) {
  const at = chainIndex(status)
  const dead = at < 0
  return (
    <ol className="flex flex-wrap items-center gap-2" aria-label="Status permintaan">
      {REQUISITION_CHAIN.map((s, i) => {
        const reached = !dead && i <= at
        return (
          <li key={s} className="flex items-center gap-2">
            <span className={`px-3 py-1 rounded-full text-xs font-bold ${reached ? 'bg-gold-600 text-white' : 'bg-gray-100 text-gray-400'}`}>
              {REQUISITION_STATUS[s].label}
            </span>
            {i < REQUISITION_CHAIN.length - 1 && <span className="text-gray-300">›</span>}
          </li>
        )
      })}
      {dead && <Badge tone={REQUISITION_STATUS[status].tone}>{REQUISITION_STATUS[status].label}</Badge>}
    </ol>
  )
}

/** Detail of one Permintaan Barang: status chain, lines, linked transfer, history and the actions the caller may take. */
export function RequisitionDetail({ id, onBack, onEdit }: RequisitionDetailProps) {
  const { user } = useAuth()
  const { outletId } = useOutlet()
  const perms = user?.permissions ?? []
  const isAdmin = user?.role === 'admin'
  const canWarehouse = isAdmin || perms.includes('manage_inventory')
  const canRequest = isAdmin || perms.includes('request_stock')

  const q = usePolledQuery<StockRequisition>(() => api.getRequisition(id), [id])
  const warehouses = usePolledQuery(() => (canWarehouse ? api.listWarehouses() : Promise.resolve([])), [canWarehouse], 600000)
  const [approved, setApproved] = useState<Record<string, string>>({})
  const [warehouseId, setWarehouseId] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // One Idempotency-Key per action until it succeeds: a retry of a failed or double-clicked action replays, not repeats.
  // A key is tied to the payload it was minted for: an action whose content changed (other quantities) gets a new key.
  const keys = useRef<Record<string, { key: string; signature: string }>>({})
  const ask = useConfirm()

  const pb = q.data
  if (!pb) {
    return (
      <div className="space-y-5">
        <PageHeader title="Permintaan Barang" actions={<Button variant="secondary" icon={<ArrowLeft className="w-4 h-4" />} onClick={onBack}>Kembali</Button>} />
        <Card className="p-8">{q.error ? <p className="text-sm text-red-600">{q.error}</p> : <TableSkeleton />}</Card>
      </div>
    )
  }

  const items = pb.items ?? []
  const linkedTransferId = pb.transfer?.id
  // A non-admin's active outlet is their own (the context outletId stays null for them).
  const activeOutlet = isAdmin ? outletId : (user?.outletId ?? null)
  const ownOutlet = canRequest && activeOutlet === pb.outletId
  const approvedFor = (itemId: string, requested: number) => approved[itemId] ?? String(requested)

  const act = async (name: string, fn: (key: string) => Promise<unknown>, signature = '') => {
    const kept = keys.current[name]
    const entry = kept && kept.signature === signature ? kept : { key: crypto.randomUUID(), signature }
    keys.current[name] = entry
    setBusy(true)
    setErr(null)
    try {
      await fn(entry.key)
      delete keys.current[name]
      await q.refetch()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Aksi gagal.')
    } finally {
      setBusy(false)
    }
  }

  /** Asks first; the action runs only on a yes. The key logic of `act` still applies, so a retry replays. */
  const confirmThen = async (
    action: RequisitionAction,
    name: string,
    fn: (key: string) => Promise<unknown>,
    detail: { approvedUnits?: number; warehouseName?: string; signature?: string } = {},
  ) => {
    const { confirmed } = await ask(requisitionConfirm(action, { number: pb.number, refulfil: canRefulfil(pb), ...detail }))
    if (confirmed) await act(name, fn, detail.signature)
  }

  const approve = () => {
    const lines = items.map((it) => ({ itemId: it.id, approvedQty: Number(approvedFor(it.id, it.requestedQty)) }))
    if (!warehouseId) return setErr('Pilih gudang sumber.')
    if (lines.some((l, i) => !Number.isInteger(l.approvedQty) || l.approvedQty < 0 || l.approvedQty > items[i].requestedQty)) {
      return setErr('Qty disetujui harus bilangan bulat antara 0 dan qty diminta.')
    }
    const body = { warehouseId, items: lines, note: note.trim() || undefined }
    void confirmThen('approve', 'approve', (key) => api.approveRequisition(pb.id, body, key), {
      approvedUnits: lines.reduce((sum, l) => sum + l.approvedQty, 0),
      warehouseName: (warehouses.data ?? []).find((w) => w.id === warehouseId)?.name,
      signature: JSON.stringify(body),
    })
  }
  const reject = () => {
    if (!note.trim()) return setErr('Catatan penolakan wajib diisi.')
    void act('reject', (key) => api.rejectRequisition(pb.id, { note: note.trim() }, key))
  }

  // Four-eyes: the creator and the submitter may not decide or fulfil (the server enforces it too).
  const participant = pb.requestedBy === user?.id || pb.submittedBy === user?.id
  const deciding = canWarehouse && !participant && pb.status === 'submitted'
  const s = REQUISITION_STATUS[pb.status]

  return (
    <div className="space-y-5">
      <PageHeader
        title={pb.number}
        subtitle={`${pb.outletName ?? 'Outlet'}${pb.neededBy ? ` · dibutuhkan ${fmtDate(pb.neededBy)}` : ''}`}
        actions={
          <>
            <Button variant="secondary" icon={<ArrowLeft className="w-4 h-4" />} onClick={onBack}>Kembali</Button>
            {ownOutlet && pb.status === 'draft' && (
              <>
                <Button variant="secondary" icon={<Pencil className="w-4 h-4" />} onClick={() => onEdit(pb)}>Ubah</Button>
                <Button icon={<Send className="w-4 h-4" />} loading={busy} onClick={() => void confirmThen('submit', 'submit', (k) => api.submitRequisition(pb.id, k))}>Ajukan</Button>
              </>
            )}
            {ownOutlet && (pb.status === 'draft' || pb.status === 'submitted') && (
              <Button variant="danger" icon={<Ban className="w-4 h-4" />} loading={busy} onClick={() => void confirmThen('cancel', 'cancel', (k) => api.cancelRequisition(pb.id, k))}>Batalkan</Button>
            )}
            {canWarehouse && !participant && (pb.status === 'approved' || canRefulfil(pb)) && (
              <Button icon={<Truck className="w-4 h-4" />} loading={busy} onClick={() => void confirmThen('fulfil', 'fulfil', (k) => api.fulfilRequisition(pb.id, k))}>
                {canRefulfil(pb) ? 'Buat Transfer Ulang' : 'Buat Transfer'}
              </Button>
            )}
          </>
        }
      />

      <Card className="p-5 space-y-4">
        <StatusChain status={pb.status} />
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-gray-500">
          <Badge tone={s.tone}>{s.label}</Badge>
          <span>Pemohon: {pb.requestedByName ?? '—'}</span>
          <span>Diajukan: {fmtDateTime(pb.submittedAt)}</span>
          {pb.warehouseName && <span>Gudang: {pb.warehouseName}</span>}
          {pb.decidedAt && <span>Keputusan: {pb.decidedByName ?? '—'} · {fmtDateTime(pb.decidedAt)}</span>}
        </div>
        {pb.note && <p className="text-sm text-gray-600">Catatan: {pb.note}</p>}
        {pb.decisionNote && <p className="text-sm text-amber-700">Catatan gudang: {pb.decisionNote}</p>}
        {pb.transfer && (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-gray-500">Transfer:</span>
            <span className="font-mono font-bold text-gray-900">{pb.transfer.transferNo}</span>
            <StatusBadge map={TRANSFER_STATUS} value={pb.transfer.status} />
            {canWarehouse && (
              <Button size="sm" variant="secondary" icon={<ExternalLink className="w-3.5 h-3.5" />} onClick={() => linkedTransferId && openTransfer(linkedTransferId)}>
                Buka Transfer
              </Button>
            )}
          </div>
        )}
      </Card>

      <Card className="p-5 space-y-4">
        {deciding && (
          <Select label="Gudang sumber" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            <option value="">Pilih gudang…</option>
            {(warehouses.data ?? []).filter((w) => w.isActive !== false).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </Select>
        )}
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              {['Produk', 'Ukuran', 'Diminta', 'Disetujui', ...(pb.transfer ? ['Di transfer'] : [])].map((h) => (
                <th key={h} className="text-left px-4 py-2 text-xs font-black text-gray-400 uppercase tracking-wider">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {items.map((it) => (
              <tr key={it.id}>
                <td className="px-4 py-2 text-sm font-bold text-gray-900">{it.productName}</td>
                <td className="px-4 py-2 text-sm text-gray-500">{variantLabel(it.variantSize)}</td>
                <td className="px-4 py-2 text-sm text-gray-500">{it.requestedQty}</td>
                <td className="px-4 py-2 text-sm text-gray-500 w-40">
                  {deciding ? (
                    <input
                      type="number" min={0} max={it.requestedQty} className={`${fieldClass} py-1.5`}
                      value={approvedFor(it.id, it.requestedQty)}
                      aria-label={`Qty disetujui ${it.productName} ${it.variantSize}`}
                      onChange={(e) => setApproved((m) => ({ ...m, [it.id]: e.target.value }))}
                    />
                  ) : (it.approvedQty ?? '—')}
                </td>
                {pb.transfer && (
                  <td className="px-4 py-2 text-sm">
                    {it.transferQty == null ? (
                      (it.approvedQty ?? 0) > 0
                        ? <span className="font-bold text-amber-700">tidak ada di transfer</span>
                        : <span className="text-gray-400">—</span>
                    ) : (
                      <span className={it.transferQty !== it.approvedQty ? 'font-bold text-amber-700' : 'text-gray-500'}
                        title={it.transferQty !== it.approvedQty ? 'Berbeda dari qty disetujui: draf transfer diubah' : undefined}>
                        {it.transferQty}
                      </span>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {deciding && (
          <>
            <Textarea label="Catatan" rows={2} placeholder="Wajib untuk menolak" value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="flex gap-3">
              <Button icon={<Check className="w-4 h-4" />} loading={busy} onClick={approve}>Setujui</Button>
              <Button variant="danger" icon={<X className="w-4 h-4" />} loading={busy} onClick={reject}>Tolak</Button>
            </div>
          </>
        )}
        {err && <p className="text-sm text-red-600">{err}</p>}
      </Card>

      <Card className="p-5">
        <h3 className="text-sm font-black text-gray-900 mb-3">Riwayat</h3>
        <ul className="space-y-2">
          {(pb.events ?? []).map((e) => (
            <li key={e.id} className="text-sm text-gray-600 flex flex-wrap gap-x-3">
              <span className="text-gray-400 w-40">{fmtDateTime(e.at)}</span>
              <span className="font-bold text-gray-900">{EVENT_LABEL[e.action] ?? e.action}</span>
              <span>{e.actorName ?? ''}</span>
              {e.note && <span className="text-gray-500">— {e.note}</span>}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
