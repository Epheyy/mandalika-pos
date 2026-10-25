import { useRef, useState } from 'react'
import { type AppSettings, type InventoryReasonCode, type WarehouseStockRow } from '@mandalika/api'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import {
  REASON_OPTIONS,
  composeReason,
  isApprovalRequired,
  newIdempotencyKey,
  reasonTextRequired,
  validateReason,
} from '../../lib/inventoryApproval'
import { Button } from '../../ui/Button'
import { Input, Select } from '../../ui/Field'
import { Modal } from '../../ui/Modal'

interface AdjustModalProps {
  location: { kind: 'outlet' | 'warehouse'; id: string; name: string }
  /** The stock row being corrected. The modal is shown while this is set. */
  row: WarehouseStockRow
  onClose: () => void
  /** Called after a successful adjust so the parent can refetch stock. */
  onDone: () => void | Promise<void>
}

const SETTINGS_POLL_MS = 600_000

/** Koreksi Stok: sets an absolute new on-hand qty (not additive) and requires a
 *  reason. With inventoryApprovalRequired it files an adjustment request that an
 *  approver must approve; otherwise it adjusts directly. Mounted only while a row
 *  is selected so its form starts fresh. */
export function AdjustModal({ location, row, onClose, onDone }: AdjustModalProps) {
  const settings = usePolledQuery<AppSettings>(() => api.getAppSettings(), [], SETTINGS_POLL_MS)
  const [newQty, setNewQty] = useState(String(row.stock))
  const [reasonCode, setReasonCode] = useState<InventoryReasonCode | ''>('')
  const [reasonText, setReasonText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [requestNumber, setRequestNumber] = useState<string | null>(null)
  // One key per attempt; any form edit starts a new action, a retry of the same form reuses it.
  const keyRef = useRef(newIdempotencyKey())
  const edit = <T,>(set: (v: T) => void) => (v: T) => {
    keyRef.current = newIdempotencyKey()
    set(v)
  }

  const qty = Number(newQty)
  const qtyOk = newQty.trim() !== '' && !Number.isNaN(qty) && qty >= 0
  const reasonErr = validateReason(reasonCode, reasonText)
  const valid = qtyOk && !reasonErr
  const approvalOn = settings.data?.inventoryApprovalRequired === true

  const createRequest = async (code: InventoryReasonCode) => {
    const req = await api.createAdjustmentRequest(
      {
        locationType: location.kind,
        locationId: location.id,
        productId: row.productId,
        variantSize: row.variantSize,
        newQty: qty,
        reasonCode: code,
        reasonText: reasonText.trim() || undefined,
      },
      keyRef.current,
    )
    setRequestNumber(req.number)
  }

  const submit = async () => {
    if (!qtyOk) return setErr('Jumlah baru wajib diisi (≥ 0).')
    if (reasonErr || !reasonCode) return setErr(reasonErr)
    setBusy(true)
    setErr(null)
    try {
      if (approvalOn) {
        await createRequest(reasonCode)
        return
      }
      try {
        await api.adjustLocationStock({ kind: location.kind, id: location.id }, {
          productId: row.productId,
          variantSize: row.variantSize,
          newQty: qty,
          reason: composeReason(reasonCode, reasonText),
        })
      } catch (e: unknown) {
        if (!isApprovalRequired(e)) throw e
        setNotice('Persetujuan wajib diaktifkan. Koreksi diajukan sebagai permintaan.')
        keyRef.current = newIdempotencyKey()
        await createRequest(reasonCode)
        return
      }
      onClose()
      await onDone()
    } catch (e: unknown) {
      // A 409 carries the server message (e.g. a request for this line is already pending).
      setErr(e instanceof Error ? e.message : 'Gagal koreksi stok.')
    } finally {
      setBusy(false)
    }
  }

  if (requestNumber) {
    return (
      <Modal
        open
        onClose={() => { onClose(); void onDone() }}
        size="sm"
        title="Menunggu persetujuan"
        subtitle={`${row.productName} · ${row.variantSize}`}
        footer={<Button className="flex-1" onClick={() => { onClose(); void onDone() }}>Tutup</Button>}
      >
        <p className="text-sm text-gray-700">
          Permintaan <span className="font-black">{requestNumber}</span> menunggu persetujuan. Stok baru berubah setelah disetujui.
        </p>
      </Modal>
    )
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title="Koreksi Stok"
      subtitle={`${row.productName} · ${row.variantSize}`}
      footer={
        <>
          <Button variant="secondary" className="flex-1" onClick={onClose}>
            Batal
          </Button>
          <Button className="flex-1" onClick={submit} loading={busy} disabled={!valid}>
            {busy ? 'Menyimpan...' : approvalOn ? 'Ajukan Koreksi' : 'Simpan Koreksi'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {approvalOn && (
          <p className="text-xs text-amber-700 bg-amber-50 rounded-xl p-3">
            Koreksi stok memerlukan persetujuan. Perubahan diterapkan setelah disetujui penyetuju lain.
          </p>
        )}
        <Input label="Stok Saat Ini" type="number" value={String(row.stock)} readOnly disabled />
        <Input
          label="Jumlah Baru *"
          type="number"
          min={0}
          value={newQty}
          onChange={(e) => edit(setNewQty)(e.target.value)}
          placeholder="0"
        />
        <Select
          label="Alasan *"
          value={reasonCode}
          onChange={(e) => edit(setReasonCode)(e.target.value as InventoryReasonCode | '')}
        >
          <option value="">Pilih alasan...</option>
          {REASON_OPTIONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
        </Select>
        <Input
          label={reasonTextRequired(reasonCode) ? 'Keterangan *' : 'Keterangan'}
          type="text"
          value={reasonText}
          onChange={(e) => edit(setReasonText)(e.target.value)}
          placeholder="mis. botol pecah saat display"
        />
        {notice && <p className="text-sm text-amber-700">{notice}</p>}
        {err && <p role="alert" className="text-sm text-red-600">{err}</p>}
      </div>
    </Modal>
  )
}
