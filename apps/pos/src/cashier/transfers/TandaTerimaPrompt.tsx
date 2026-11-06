/**
 * SP4 D3: Modal prompt shown after a transfer_receive is accepted.
 *
 * Props:
 *   transfer      — the completed Transfer snapshot from the ack
 *   receivedByName — cashier display name (passed in by CashierScreen)
 *   receiptSettings — ReceiptSettings from snapshot.appSettings.receipt
 *   onClose       — called on success or on "Lewati"
 */

import { useState } from 'react'
import type { components } from '@mandalika/api'
import { usePrinter } from '../../printer'
import { buildTandaTerimaData } from './buildTandaTerimaData'
import { Sheet } from '../../components/ui/Sheet'
import { Button } from '../../components/ui/Button'
import { Banner } from '../../components/ui/Banner'

type Transfer = components['schemas']['Transfer']
type ReceiptSettings = components['schemas']['ReceiptSettings']

interface Props {
  transfer: Transfer
  receivedByName: string
  receiptSettings: ReceiptSettings
  onClose: () => void
}

export function TandaTerimaPrompt({ transfer, receivedByName, receiptSettings, onClose }: Props) {
  const printer = usePrinter()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const handleCetak = async () => {
    if (!printer.isPaired || busy) return
    setBusy(true)
    setErr(null)
    try {
      const data = buildTandaTerimaData(transfer, receivedByName)
      await printer.printTandaTerima(data, receiptSettings)
      onClose()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Gagal mencetak tanda terima'
      setErr(msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open variant="center" z={70} maxWidth="max-w-sm">
        {/* Header */}
        <div className="px-5 pt-5 pb-4 border-b border-paper-2">
          <h3 className="font-bold text-ink-900 text-base">Tanda terima siap</h3>
          <p className="text-sm text-ink-700 mt-0.5">
            {transfer.tandaTerimaNo} · dari {transfer.source.name ?? transfer.source.id}
          </p>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-3">
          {!printer.isPaired && (
            <Banner tone="warn" className="rounded-control" message="Pasangkan printer di Pengaturan untuk cetak." />
          )}

          {err && <Banner tone="danger" className="rounded-control" message={err} />}
        </div>

        {/* Actions */}
        <div className="px-5 pb-5 space-y-2">
          <Button fullWidth onClick={() => void handleCetak()} disabled={!printer.isPaired || busy}>
            {busy ? 'Mencetak…' : 'Cetak'}
          </Button>
          <Button variant="secondary" fullWidth onClick={onClose} disabled={busy}>
            Lewati
          </Button>
        </div>
    </Sheet>
  )
}
