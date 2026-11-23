import { useRef, useState, type ReactNode } from 'react'
import { QR_NATIVE_URL_MAX, RECEIPT_LIMITS, toPrinterText, type ReceiptBlock, type TxField } from '@mandalika/printer/render'
import { Button } from '../../../ui/Button'
import { Input, Textarea } from '../../../ui/Field'
import { Switch } from '../../../ui/Switch'
import { cn } from '../../../ui/cn'
import { fileToRaster, urlToRaster } from './imageToRaster'
import { rasterToBmpDataUrl } from './rasterPreview'

type Patch = Partial<ReceiptBlock>

interface BlockEditorProps {
  block: ReceiptBlock
  onChange: (patch: Patch) => void
  /** `documents.logoUrl`; without it the logo editor has no "Ambil logo brand" button. */
  brandLogoUrl?: string
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
export function BlockEditor({ block, onChange, brandLogoUrl }: BlockEditorProps) {
  return (
    <div data-testid={`editor-${block.type}`} className="mb-1 ml-6 mt-1.5 space-y-2 rounded-r-lg border-l-2 border-brand-strong bg-paper-1 p-3">
      <EditorBody block={block} onChange={onChange} brandLogoUrl={brandLogoUrl} />
    </div>
  )
}

function EditorBody({ block, onChange, brandLogoUrl }: BlockEditorProps) {
  switch (block.type) {
    case 'image':
      return <ImageEditor image={block.image} align={block.align} brandLogoUrl={brandLogoUrl} onChange={onChange} />
    case 'qr':
      return (
        <>
          <QrUrlField url={block.url} onChange={(url) => onChange({ url })} />
          <Row label="Rata"><Seg label="Perataan QR" value={block.align} options={ALIGN_OPTIONS} onChange={(align) => onChange({ align })} /></Row>
        </>
      )
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
          <p className="text-xs text-ink-700">Total selalu dicetak. Baris diskon dan pajak tetap tercetak bila ada potongan di transaksi.</p>
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

/** Why a QR address cannot be saved, in the words the shared validator uses; null when it is fine. */
function qrUrlIssue(url: string): string | null {
  if ([...url].length > RECEIPT_LIMITS.urlMax) return `Alamat QR maksimal ${RECEIPT_LIMITS.urlMax} karakter.`
  if (!/^https?:\/\/[!-~]+$/.test(url)) return 'Alamat QR harus diawali http:// atau https:// dan hanya berisi karakter ASCII.'
  return null
}

/** The QR address with a live `n/300` counter. Typing past 300 is allowed so the admin sees the error; Simpan refuses it. */
function QrUrlField({ url, onChange }: { url: string; onChange: (url: string) => void }) {
  const issue = qrUrlIssue(url)
  const count = [...url].length
  return (
    <div>
      <Input
        label="Alamat web (URL)" type="text" inputMode="url" value={url} error={issue ?? undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      <p data-testid="qr-counter" className={cn('mt-1 text-[11px]', issue ? 'text-danger' : 'text-ink-700')}>{count}/{RECEIPT_LIMITS.urlMax}</p>
      {!issue && count > QR_NATIVE_URL_MAX && (
        <p data-testid="qr-long-hint" className="mt-1 text-[11px] text-ink-700">
          Lebih dari {QR_NATIVE_URL_MAX} karakter: printer RPP02N tidak bisa membuat kotak QR sepanjang ini, jadi alamat dicetak sebagai teks.
        </p>
      )}
    </div>
  )
}

function ImageEditor({ image, align, brandLogoUrl, onChange }: {
  image: Extract<ReceiptBlock, { type: 'image' }>['image']
  align: 'left' | 'center' | 'right'
  brandLogoUrl?: string
  onChange: (patch: Patch) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async (load: () => Promise<typeof image>) => {
    setBusy(true)
    setError(null)
    try {
      onChange({ image: await load() } as Patch)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Gagal memuat gambar.')
    } finally {
      setBusy(false)
    }
  }
  const preview = rasterToBmpDataUrl(image)
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" aria-label="Unggah logo" className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) void run(() => fileToRaster(file))
          }}
        />
        <Button size="sm" variant="secondary" loading={busy} onClick={() => fileRef.current?.click()}>Unggah logo</Button>
        {brandLogoUrl && <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => urlToRaster(brandLogoUrl))}>Ambil logo brand</Button>}
      </div>
      {error && <p role="alert" className="text-xs font-bold text-danger">{error}</p>}
      {preview && (
        <img
          src={preview} alt="Hasil logo untuk printer" width={image.width} height={image.height}
          className="max-w-full border border-paper-2 bg-white" style={{ imageRendering: 'pixelated' }}
        />
      )}
      <p className="text-xs text-ink-700">Gambar diubah jadi hitam-putih dan dimuat dalam 384 x 240 titik. Pratinjau ini yang dicetak.</p>
      <Row label="Rata"><Seg label="Perataan logo" value={align} options={ALIGN_OPTIONS} onChange={(a) => onChange({ align: a })} /></Row>
    </>
  )
}
