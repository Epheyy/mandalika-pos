import { useState, type ReactNode } from 'react'
import { RECEIPT_LIMITS, toPrinterText, type ReceiptBlock, type TxField } from '@mandalika/printer/render'
import { Input, Textarea } from '../../../ui/Field'
import { Switch } from '../../../ui/Switch'
import { cn } from '../../../ui/cn'

type Patch = Partial<ReceiptBlock>

interface BlockEditorProps {
  block: ReceiptBlock
  onChange: (patch: Patch) => void
}

/** A small segmented choice (Normal | Besar), as in the mockup. */
export function Seg<T extends string | number>({ label, value, options, onChange }: {
  label: string
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (v: T) => void
}) {
  return (
    <span role="radiogroup" aria-label={label} className="inline-flex overflow-hidden rounded-lg border border-paper-2">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            'px-2.5 py-1 text-xs font-bold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-strong',
            o.value === value ? 'bg-ink-900 text-white' : 'bg-white text-ink-700 hover:bg-paper-1',
          )}
        >
          {o.label}
        </button>
      ))}
    </span>
  )
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="inline-flex items-center gap-1.5 rounded-lg border border-paper-2 bg-white px-2 py-1 text-xs font-bold text-ink-900">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-brand-strong" aria-label={label} />
      {label}
    </label>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 first:mt-0">
      <span className="min-w-14 text-xs font-bold text-ink-700">{label}</span>
      {children}
    </div>
  )
}

const SIZE_OPTIONS = [{ value: 'normal', label: 'Normal' }, { value: 'large', label: 'Besar' }] as const
const ALIGN_OPTIONS = [{ value: 'left', label: 'Kiri' }, { value: 'center', label: 'Tengah' }, { value: 'right', label: 'Kanan' }] as const
const STYLE_OPTIONS = [{ value: 'columns', label: 'Kolom' }, { value: 'inline', label: 'Sebaris' }] as const

const TX_LABELS: ReadonlyArray<{ field: TxField; label: string }> = [
  { field: 'orderNumber', label: 'Nomor pesanan' },
  { field: 'date', label: 'Tanggal' },
  { field: 'cashier', label: 'Dicetak oleh' },
  { field: 'customerName', label: 'Nama Pelanggan' },
  { field: 'customerPhone', label: 'Nomor Telepon' },
]

/** What the printer will show for typed text, or null when it prints exactly as typed. */
export function printableHint(typed: string): string | null {
  const printed = toPrinterText(typed)
  if (printed === typed) return null
  const swapped = [...new Set([...typed].filter((ch) => toPrinterText(ch) !== ch))].slice(0, 6).join(' ')
  return `Karakter ${swapped} diganti agar bisa dicetak (jadi "${printed.slice(0, 40)}").`
}

/** A text box that keeps what was typed, so the admin sees what the printer will do to it. */
function PrintableText({ label, value, multiline, maxLength, onChange }: {
  label: string
  value: string
  multiline: boolean
  maxLength: number
  onChange: (text: string) => void
}) {
  const [typed, setTyped] = useState(value)
  // The stored value is the printable form; show what was typed while it still maps to it.
  const shown = toPrinterText(typed) === value ? typed : value
  const hint = printableHint(shown)
  const props = {
    label,
    value: shown,
    maxLength,
    hint: hint ?? `${[...shown].length}/${maxLength}`,
    onChange: (e: { target: { value: string } }) => {
      setTyped(e.target.value)
      onChange(e.target.value)
    },
  }
  return multiline ? <Textarea rows={3} {...props} /> : <Input type="text" {...props} />
}

/** The per-type form opened under the selected row. Locked blocks (items, totals, payment) have no on/off here. */
export function BlockEditor({ block, onChange }: BlockEditorProps) {
  return (
    <div data-testid={`editor-${block.type}`} className="mb-1 ml-6 mt-1.5 space-y-2 rounded-r-lg border-l-2 border-brand-strong bg-paper-1 p-3">
      <EditorBody block={block} onChange={onChange} />
    </div>
  )
}

function EditorBody({ block, onChange }: BlockEditorProps) {
  switch (block.type) {
    case 'header':
      return (
        <>
          <PrintableText label="Judul" value={block.text} multiline={false} maxLength={RECEIPT_LIMITS.titleMax} onChange={(text) => onChange({ text })} />
          <Row label="Ukuran"><Seg label="Ukuran judul" value={block.size} options={SIZE_OPTIONS} onChange={(size) => onChange({ size })} /></Row>
          <Row label="Tampilkan">
            <Check label="Nama outlet" checked={block.showOutletName} onChange={(showOutletName) => onChange({ showOutletName })} />
            <Check label="Alamat" checked={block.showOutletAddress} onChange={(showOutletAddress) => onChange({ showOutletAddress })} />
            <Check label="Telepon" checked={block.showOutletPhone} onChange={(showOutletPhone) => onChange({ showOutletPhone })} />
          </Row>
        </>
      )
    case 'transaction':
      return (
        <>
          <Row label="Tampilkan">
            {TX_LABELS.map(({ field, label }) => (
              <Check
                key={field}
                label={label}
                checked={block.fields.includes(field)}
                onChange={(on) => onChange({ fields: TX_LABELS.map((t) => t.field).filter((f) => (f === field ? on : block.fields.includes(f))) })}
              />
            ))}
          </Row>
          <Row label="Gaya"><Seg label="Gaya baris" value={block.style} options={STYLE_OPTIONS} onChange={(style) => onChange({ style })} /></Row>
        </>
      )
    case 'items':
      return <p className="text-xs text-ink-700">Daftar barang selalu dicetak.</p>
    case 'totals':
      return (
        <>
          {([['showSubtotal', 'Tampilkan Subtotal'], ['showDiscount', 'Tampilkan Diskon'], ['showTax', 'Tampilkan Pajak']] as const).map(([key, label]) => (
            <div key={key} className="flex items-center justify-between">
              <span className="text-sm font-bold text-ink-900">{label}</span>
              <Switch label={label} size="sm" checked={block[key]} onChange={(on) => onChange({ [key]: on })} />
            </div>
          ))}
          <p className="text-xs text-ink-700">TOTAL selalu dicetak. Baris diskon dan pajak tetap tercetak bila ada potongan di transaksi.</p>
        </>
      )
    case 'payment':
      return <p className="text-xs text-ink-700">Pembayaran dan kembalian selalu dicetak.</p>
    case 'points':
      return <p className="text-xs text-ink-700">Dicetak pada penjualan langsung sebagai perkiraan poin; tidak pada cetak ulang.</p>
    case 'text':
      return (
        <>
          <Input
            label="Label (opsional)" type="text" value={block.label ?? ''} maxLength={RECEIPT_LIMITS.labelMax}
            hint="Hanya untuk Anda di daftar ini; tidak dicetak."
            onChange={(e) => onChange(e.target.value === '' ? { label: undefined } : { label: e.target.value })}
          />
          <PrintableText label="Teks" value={block.text} multiline maxLength={RECEIPT_LIMITS.textMax} onChange={(text) => onChange({ text })} />
          <Row label="Rata"><Seg label="Perataan teks" value={block.align} options={ALIGN_OPTIONS} onChange={(align) => onChange({ align })} /></Row>
          <Row label="Ukuran"><Seg label="Ukuran teks" value={block.size} options={SIZE_OPTIONS} onChange={(size) => onChange({ size })} /></Row>
          <div className="flex items-center justify-between">
            <span className="text-sm font-bold text-ink-900">Tebal</span>
            <Switch label="Teks tebal" size="sm" checked={block.bold} onChange={(bold) => onChange({ bold })} />
          </div>
        </>
      )
    case 'divider':
      return <p className="text-xs text-ink-700">Garis pemisah selebar kertas.</p>
  }
}
