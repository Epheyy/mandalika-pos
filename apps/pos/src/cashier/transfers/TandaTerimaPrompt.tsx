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
        <div className="px-5 pt-5 pb-4 border-b border-gray-100">
          <h3 className="font-bold text-gray-900 text-base">Tanda terima siap</h3>
          <p className="text-sm text-gray-500 mt-0.5">
            {transfer.tandaTerimaNo} · dari {transfer.source.name ?? transfer.source.id}
          </p>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-3">
          {!printer.isPaired && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5">
              <p className="text-xs font-semibold text-amber-700">
                Pasangkan printer di Pengaturan untuk cetak.
              </p>
            </div>
          )}

          {err && (
            <div className="bg-red-50 border border-red-200 rounded-xl px-3 py-2.5">
              <p className="text-xs font-semibold text-red-700">{err}</p>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="px-5 pb-5 space-y-2">
          <button type="button"
            onClick={() => void handleCetak()}
            disabled={!printer.isPaired || busy}
            className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white font-bold text-sm rounded-xl transition-all"
          >
            {busy ? 'Mencetak…' : 'Cetak'}
          </button>
          <button type="button"
            onClick={onClose}
            disabled={busy}
            className="w-full py-2.5 border border-gray-200 text-gray-600 font-semibold text-sm rounded-xl hover:bg-gray-50 disabled:opacity-40 transition-all"
          >
            Lewati
          </button>
        </div>
    </Sheet>
  )
}
