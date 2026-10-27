import { useState } from 'react'
import { Sheet } from '../components/ui/Sheet'
import { Button } from '../components/ui/Button'
import { IconClose } from '../components/ui/icons'
import { formatRupiah } from './pricing'
import type { HeldOrder } from './heldOrders'

interface Props {
  open: boolean
  onClose: () => void
  held: readonly HeldOrder[]
  /** The current cart has items: the name field and "Simpan pesanan" are shown. */
  canSave: boolean
  defaultName: string
  onSave: (name: string) => void
  onResume: (order: HeldOrder) => void
  onDelete: (order: HeldOrder) => void
}

const heldTime = (at: number): string => {
  const d = new Date(at)
  const p = (n: number) => (n < 10 ? `0${n}` : `${n}`)
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`
}
const unitCount = (o: HeldOrder): number => o.lines.reduce((n, l) => n + l.quantity, 0)
const lineTotal = (o: HeldOrder): number => o.lines.reduce((n, l) => n + l.subtotal, 0)

/** D-6 "Pesanan tersimpan": park the cart under a name, list what is parked on this tablet, resume or delete. */
export function HeldOrdersSheet({ open, onClose, held, canSave, defaultName, onSave, onResume, onDelete }: Props) {
  const [name, setName] = useState('')
  if (!open) return null
  return (
    <Sheet open onClose={onClose} variant="side" z={50} title={null} panelClassName="flex flex-col" testId="held-orders-sheet">
      <div className="flex flex-shrink-0 items-center justify-between border-b border-paper-2 py-1 pl-4 pr-2">
        <h2 className="text-base font-bold text-ink-900">Pesanan tersimpan{held.length > 0 ? ` (${held.length})` : ''}</h2>
        <Button variant="ghost" onClick={onClose} aria-label="Tutup" className="min-h-11 px-2"><IconClose size={18} /></Button>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <p className="mb-3 text-[0.8125rem] text-ink-500">Hanya di tablet ini. Tidak ikut terkirim sebagai transaksi sampai dibayar.</p>
        {canSave && (
          <form
            className="mb-4 rounded-xl border border-paper-2 p-3"
            onSubmit={(e) => { e.preventDefault(); onSave(name.trim() || defaultName); setName('') }}
          >
            <label htmlFor="held-name" className="mb-1 block text-xs font-bold uppercase tracking-wide text-ink-500">Nama pesanan</label>
            <input
              id="held-name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={defaultName} maxLength={40}
              className="mb-3 min-h-12 w-full rounded-control border border-paper-2 bg-paper-1 px-3 text-sm focus:border-ink-700 focus:outline-none"
            />
            <Button type="submit" fullWidth>Simpan pesanan</Button>
          </form>
        )}
        {held.length === 0 ? (
          <p className="py-6 text-center text-[0.9375rem] text-ink-500">Belum ada pesanan tersimpan</p>
        ) : (
          <ul className="space-y-2">
            {held.map((o) => (
              <li key={o.id} className="rounded-xl border border-paper-2 p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="truncate text-[0.9375rem] font-semibold text-ink-900">{o.name}</p>
                  <p className="tnum flex-shrink-0 text-[0.8125rem] text-ink-500">{heldTime(o.heldAt)}</p>
                </div>
                <p className="tnum text-[0.8125rem] text-ink-500">{unitCount(o)} item · {formatRupiah(lineTotal(o))}</p>
                <div className="mt-2 flex gap-2">
                  <Button variant="secondary" onClick={() => onResume(o)} aria-label={`Lanjutkan ${o.name}`} className="flex-1">Lanjutkan</Button>
                  <Button variant="ghost" onClick={() => onDelete(o)} aria-label={`Hapus ${o.name}`} className="flex-1 text-danger-solid">Hapus</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Sheet>
  )
}
