import { useState } from 'react'
import type { ReceiptLayout } from '@mandalika/printer/render'
import { Button } from '../../../ui/Button'
import { Select } from '../../../ui/Field'
import { Modal } from '../../../ui/Modal'
import { sendTestPrint, type TestPrintApi, type TestPrintResult } from './receiptTemplates'

interface OutletRef {
  id: string
  name: string
}

interface TestPrintDialogProps {
  open: boolean
  outlets: readonly OutletRef[]
  /** The layout as it is now, saved or not. */
  draftLayout: ReceiptLayout
  api: TestPrintApi
  onClose: () => void
}

/** Sends the draft on screen to one outlet's tablet; the tablet prints it when someone taps Tes Cetak there. */
export function TestPrintDialog(props: TestPrintDialogProps) {
  if (!props.open) return null
  return <TestPrintBody {...props} />
}

function TestPrintBody({ outlets, draftLayout, api, onClose }: TestPrintDialogProps) {
  const [outletId, setOutletId] = useState(outlets[0]?.id ?? '')
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<TestPrintResult | null>(null)
  const outlet = outlets.find((o) => o.id === outletId)

  const send = async () => {
    if (!outlet) return
    setSending(true)
    setResult(null)
    setResult(await sendTestPrint(api, outlet, draftLayout))
    setSending(false)
  }

  return (
    <Modal
      confirmDiscard={false}
      open
      onClose={onClose}
      title="Cetak tes di tablet"
      subtitle="Mengirim desain yang sedang tampil, termasuk yang belum disimpan."
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={sending}>Selesai</Button>
          <Button loading={sending} disabled={!outlet} onClick={() => void send()}>Kirim</Button>
        </>
      }
    >
      {outlets.length === 0 ? (
        <p className="text-sm text-ink-700">Belum ada outlet.</p>
      ) : (
        <Select label="Outlet" value={outletId} onChange={(e) => { setOutletId(e.target.value); setResult(null) }}>
          {outlets.map((o) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
        </Select>
      )}
      <p className="mt-3 text-xs text-ink-700">
        Logo dan QR tercetak di tablet hanya jika <b>Cetak logo &amp; QR</b> menyala di Pengaturan › Cetakan tablet itu.
      </p>
      {result && (
        <p
          role={result.kind === 'error' ? 'alert' : 'status'}
          className={`mt-3 rounded-xl px-3 py-2 text-sm font-bold ${result.kind === 'error' ? 'bg-danger-bg text-danger' : 'bg-ok-bg text-ok'}`}
        >
          {result.message}
        </p>
      )}
    </Modal>
  )
}
