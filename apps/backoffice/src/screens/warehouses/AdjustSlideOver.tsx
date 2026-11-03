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
import { SlideOver } from '../../ui/SlideOver'
import { stockChangeLine, stockWriteError } from './stockWrite'
import { useStockWriteGuard } from './useStockWriteGuard'

interface AdjustSlideOverProps {
  location: { kind: 'outlet' | 'warehouse'; id: string; name: string }
  /** The stock row being adjusted. The panel is shown while this is set. */
  row: WarehouseStockRow
  onClose: () => void
  /** Called after a successful adjust so the parent can refetch stock. */
  onDone: () => void | Promise<void>
}

const SETTINGS_POLL_MS = 600_000

/** Penyesuaian Stok: sets an absolute new on-hand qty (not additive) and requires a reason. With
 *  inventoryApprovalRequired it files an adjustment request that an approver must approve; otherwise it adjusts
 *  directly. Mounted only while a row is selected, so its form and its Idempotency-Keys start fresh on every open. */
export function AdjustSlideOver({ location, row, onClose, onDone }: AdjustSlideOverProps) {
  const settings = usePolledQuery<AppSettings>(() => api.getAppSettings(), [], SETTINGS_POLL_MS)
  const [newQty, setNewQty] = useState(String(row.stock))
  const [reasonCode, setReasonCode] = useState<InventoryReasonCode | ''>('')
  const [reasonText, setReasonText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [requestNumber, setRequestNumber] = useState<string | null>(null)
  // One key per operation for this open, never rotated: the direct adjust and the approval request are different
  // operations, so they have their own. An edit after an attempt that may have landed meets the server's 409
  // (same key, other payload) instead of applying twice.
  const [adjustKey] = useState(newIdempotencyKey)
  const [requestKey] = useState(newIdempotencyKey)
  const inFlight = useRef(false)
  // Once an attempt went out by one path (direct adjust or approval request) every retry of this open takes the same
  // one, even if the approval setting flips meanwhile: an adjust that may have landed must not be followed by a request.
  const sentVia = useRef<'direct' | 'request' | null>(null)

  const qty = Number(newQty)
  const qtyOk = newQty.trim() !== '' && !Number.isNaN(qty) && qty >= 0
  const reasonErr = validateReason(reasonCode, reasonText)
  const valid = qtyOk && !reasonErr
  const approvalOn = settings.data?.inventoryApprovalRequired === true
  const changeLine = stockChangeLine(row.stock, qtyOk ? qty : null)
  const dirty = !requestNumber && (newQty !== String(row.stock) || reasonCode !== '' || reasonText !== '')
  useStockWriteGuard(busy, dirty)

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
      requestKey,
    )
    setRequestNumber(req.number)
  }

  const submit = async () => {
    if (inFlight.current) return
    if (!qtyOk) return setErr('Jumlah baru wajib diisi (≥ 0).')
    if (reasonErr || !reasonCode) return setErr(reasonErr)
    inFlight.current = true
    setBusy(true)
    setErr(null)
    try {
      if (sentVia.current === 'request' || (sentVia.current === null && approvalOn)) {
        sentVia.current = 'request'
        await createRequest(reasonCode)
        return
      }
      sentVia.current = 'direct'
      try {
        await api.adjustLocationStock(
          { kind: location.kind, id: location.id },
          {
            productId: row.productId,
            variantSize: row.variantSize,
            newQty: qty,
            reason: composeReason(reasonCode, reasonText),
          },
          adjustKey,
        )
      } catch (e: unknown) {
        if (!isApprovalRequired(e)) throw e
        setNotice('Persetujuan wajib diaktifkan. Penyesuaian diajukan sebagai permintaan.')
        sentVia.current = 'request'
        await createRequest(reasonCode)
        return
      }
      onClose()
      await onDone()
    } catch (e: unknown) {
      // A 409 carries the server message (e.g. a request for this line is already pending).
      setErr(stockWriteError(e, 'Gagal menyesuaikan stok.'))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  // No closing mid-flight: a reopen would get new keys while this write may still land.
  const close = () => {
    if (!busy) onClose()
  }
  const closeAfterRequest = () => {
    onClose()
    void onDone()
  }

  if (requestNumber) {
    return (
      <SlideOver
        open
        onClose={closeAfterRequest}
        title="Penyesuaian Stok"
        subtitle={`${row.productName} · ${row.variantSize}`}
        dirty={false}
        footer={
          <SlideOver.Footer>
            <Button onClick={closeAfterRequest}>Tutup</Button>
          </SlideOver.Footer>
        }
      >
        <p className="text-sm text-gray-700">
          Permintaan <span className="font-black">{requestNumber}</span> menunggu persetujuan. Stok baru berubah setelah disetujui.
        </p>
      </SlideOver>
    )
  }

  return (
    <SlideOver
      open
      onClose={close}
      title="Penyesuaian Stok"
      subtitle={`${row.productName} · ${row.variantSize}`}
      dirty={dirty}
      footer={
        <SlideOver.Footer dirty={dirty}>
          <Button variant="secondary" onClick={close} disabled={busy}>
            Batal
          </Button>
          <Button onClick={submit} loading={busy} disabled={!valid}>
            {busy ? 'Menyimpan...' : approvalOn ? 'Ajukan penyesuaian' : 'Simpan penyesuaian'}
          </Button>
        </SlideOver.Footer>
      }
    >
      <div className="space-y-4">
        {approvalOn && (
          <p className="text-xs text-amber-700 bg-amber-50 rounded-xl p-3">
            Penyesuaian stok memerlukan persetujuan. Perubahan diterapkan setelah disetujui penyetuju lain.
          </p>
        )}
        <Input
          label="Jumlah Baru *"
          type="number"
          min={0}
          value={newQty}
          onChange={(e) => setNewQty(e.target.value)}
          placeholder="0"
        />
        <p className="text-sm font-bold text-gray-900">
          {changeLine ?? `Stok sekarang ${row.stock}`}
        </p>
        <Select
          label="Alasan *"
          value={reasonCode}
          onChange={(e) => setReasonCode(e.target.value as InventoryReasonCode | '')}
        >
          <option value="">Pilih alasan...</option>
          {REASON_OPTIONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
        </Select>
        <Input
          label={reasonTextRequired(reasonCode) ? 'Keterangan *' : 'Keterangan'}
          type="text"
          value={reasonText}
          onChange={(e) => setReasonText(e.target.value)}
          placeholder="mis. botol pecah saat display"
        />
        {notice && <p className="text-sm text-amber-700">{notice}</p>}
        {err && <p role="alert" className="text-sm text-red-600">{err}</p>}
      </div>
    </SlideOver>
  )
}
