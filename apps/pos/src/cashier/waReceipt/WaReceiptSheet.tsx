import { useState } from 'react'
import type { Api, ReceiptLink } from '@mandalika/api'
import { api as realApi } from '../../api'
import { Sheet } from '../../components/ui/Sheet'
import { Button } from '../../components/ui/Button'
import { WA_NOT_SYNCED, WA_OFFLINE, createWaLink, openWhatsApp, type WaTarget } from './sendWaReceipt'

interface Props {
  open: boolean
  onClose: () => void
  target: WaTarget
  /** Phone prefilled from the customer (editable); '' for a Riwayat order. */
  initialPhone: string
  /** The order has a customer: a blank phone is allowed and the server uses the stored number (Riwayat). */
  allowEmptyPhone: boolean
  isOnline: boolean
  /** The server has this sale. A just-made sale is synced only after the engine flushed it. */
  isSynced: boolean
  /** The engine's public flush (useOfflineData.flush); asked for when the sale is not synced yet. */
  flush: () => void
  deviceId?: string
  /** Test seam; defaults to the app's api client. */
  api?: Pick<Api, 'createReceiptLink'>
}

/** Online-only: the server builds the WhatsApp link, the cashier presses "Buka WhatsApp", then Kirim inside WhatsApp. */
export function WaReceiptSheet({ open, onClose, target, initialPhone, allowEmptyPhone, isOnline, isSynced, flush, deviceId, api = realApi }: Props) {
  const [phone, setPhone] = useState(initialPhone)
  const [link, setLink] = useState<ReceiptLink | null>(null)
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retryable, setRetryable] = useState(false)

  const create = async () => {
    if (busy) return
    setError(null)
    setRetryable(false)
    if (isOnline && !isSynced) {
      flush()
      setError(WA_NOT_SYNCED)
      setRetryable(true)
      return
    }
    setBusy(true)
    const r = await createWaLink(api, target, { isOnline, phone, allowEmptyPhone, deviceId })
    setBusy(false)
    if (r.ok) {
      setLink(r.link)
      setOpened(false)
      return
    }
    if (r.notSynced) flush()
    setError(r.error)
    setRetryable(r.notSynced)
  }

  const showError = !isOnline ? WA_OFFLINE : error
  return (
    <Sheet open={open} onClose={onClose} variant="center" z={70} title="Kirim struk via WhatsApp" testId="wa-receipt-sheet">
      <div className="px-5 pb-5 pt-3 space-y-3">
        <div>
          <label htmlFor="wa-phone" className="block text-xs text-ink-700 font-semibold mb-1">Nomor WhatsApp</label>
          <input id="wa-phone" type="text" inputMode="tel" autoComplete="off" value={phone} disabled={!isOnline || busy}
            placeholder="0812 3456 7890"
            onChange={(e) => { setPhone(e.target.value); setLink(null); setOpened(false); setError(null) }}
            className="w-full min-h-11 surface-card rounded-control px-3 text-sm text-ink-900 focus:outline-none focus:ring-2 focus:ring-brand-strong disabled:opacity-50" />
          {allowEmptyPhone && <p className="text-xs text-ink-500 mt-1">Kosongkan untuk memakai nomor pelanggan</p>}
        </div>

        {showError && <p className="text-sm font-semibold text-warn-strong bg-warn-bg rounded-control px-3 py-2" role="alert">{showError}</p>}

        {!link ? (
          <Button fullWidth disabled={!isOnline || busy} onClick={() => void create()}>
            {busy ? 'Membuat…' : retryable ? 'Coba lagi' : 'Buat pesan'}
          </Button>
        ) : (
          <div className="space-y-3">
            <p className="whitespace-pre-wrap break-words text-sm text-ink-900 surface-card rounded-control p-3 max-h-48 overflow-y-auto" data-testid="wa-message">{link.message}</p>
            <Button fullWidth disabled={!isOnline} onClick={() => { openWhatsApp(link); setOpened(true) }}>Buka WhatsApp</Button>
            <p className="text-xs text-ink-500 text-center">Pesan terbuka di WhatsApp, tekan Kirim di sana.</p>
            {opened && (
              <div className="flex gap-2">
                <Button variant="secondary" fullWidth disabled={!isOnline || busy} onClick={() => void create()}>Kirim ulang</Button>
                <Button variant="ghost" fullWidth onClick={onClose}>Selesai</Button>
              </div>
            )}
          </div>
        )}
        {!link && <Button variant="ghost" fullWidth onClick={onClose}>Batal</Button>}
      </div>
    </Sheet>
  )
}
