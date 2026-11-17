import { useEffect, useRef, useState } from 'react'
import type { Order } from '@mandalika/api'
import type { Customer } from '@mandalika/api'
import { Ban } from 'lucide-react'
import { api } from '../../api'
import { useAuth } from '../../auth'
import { BRAND } from '../../lib/brand'
import { VOID_REASONS, type VoidReasonCode } from '../../lib/labels/void'
import { useMoneyField } from '../../lib/moneyInput'
import { methodLabel } from '../../lib/splitPayment'
import { Button } from '../../ui/Button'
import { Select, Textarea, fieldClass } from '../../ui/Field'
import { Modal } from '../../ui/Modal'
import { customerLookupTerm, isPhoneOnlyCustomerLookup } from '../promotions/customerLookupMode'
import {
  VOID_CHOICES, bundleBlocksPerbaiki, countedChoices, nextVoidAttempt, submitVoid, tendersFromOrder, voidAttemptKey,
  voidFormProblem, voidRequestBody, type StockChoice, type TenderInput, type VoidAttempt, type VoidChoice, type VoidFormValues,
} from './voidForm'

type Preview = Awaited<ReturnType<typeof api.getVoidPreview>>
type Methods = ReadonlyArray<{ id: string; label: string; isCash?: boolean | null; isEnabled?: boolean }>

const money = (n: number) => BRAND.currency.format(n)

interface Props {
  order: Order
  methods?: Methods
  /** Called after a void, or after a failure that may have changed the order, so the caller reloads. */
  onDone: () => Promise<void> | void
}

function AmountField({ raw, onRaw, label }: { raw: string; onRaw: (raw: string) => void; label: string }) {
  const field = useMoneyField(raw, onRaw)
  return <input {...field} inputMode="numeric" aria-label={label} placeholder="Rp 0" className={`${fieldClass} h-10 py-0! w-40`} />
}

/** Customer search for the replacement; a phone-only caller (A30) searches on Enter / Cari. */
function CustomerSearch({ onPick }: { onPick: (c: Customer) => void }) {
  const { user } = useAuth()
  const phone = isPhoneOnlyCustomerLookup(user)
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [results, setResults] = useState<Customer[]>([])
  const [failed, setFailed] = useState(false)
  const term = customerLookupTerm(phone, query, submitted)
  useEffect(() => {
    if (!term) return
    let ignore = false
    const t = setTimeout(async () => {
      try {
        const found = phone ? await api.lookupCustomerByPhone(term) : await api.lookupCustomers(term, 10)
        if (!ignore) { setResults(found); setFailed(false) }
      } catch {
        if (!ignore) { setResults([]); setFailed(true) }
      }
    }, phone ? 0 : 250)
    return () => { clearTimeout(t); ignore = true }
  }, [term, phone])
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          type="text" value={query} aria-label="Cari pelanggan pengganti" className={fieldClass}
          placeholder={phone ? 'No. HP lengkap pelanggan…' : 'Cari nama / no. HP pelanggan…'}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (phone && e.key === 'Enter') { e.preventDefault(); setSubmitted(query) } }}
        />
        {phone && <Button variant="secondary" onClick={() => setSubmitted(query)}>Cari</Button>}
      </div>
      {term && failed && <p role="alert" className="text-xs text-danger">Pencarian pelanggan gagal. Coba lagi.</p>}
      {term && !failed && (
        <div className="max-h-40 overflow-auto rounded-lg border border-paper-2 bg-white">
          {results.length === 0 ? <p className="px-3 py-2 text-xs text-ink-500">Tidak ada pelanggan cocok.</p> : results.map((c) => (
            <button key={c.id} type="button" onClick={() => { onPick(c); setQuery(''); setSubmitted(''); setResults([]) }}
              className="flex w-full items-center justify-between border-b border-paper-1 px-3 py-2 text-left text-sm last:border-0 hover:bg-paper-1">
              <span className="font-medium text-ink-900">{c.name}</span><span className="text-xs text-ink-500">{c.phone}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Void (Batalkan) of a completed sale from Laporan > Transaksi (needs void_any; the server enforces it). */
export function VoidOrderForm({ order, methods, onDone }: Props) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<VoidReasonCode | null>(null)
  const [note, setNote] = useState('')
  const [choice, setChoice] = useState<VoidChoice>('saja')
  const [tenders, setTenders] = useState<TenderInput[]>(() => tendersFromOrder(order))
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(null)
  const [picks, setPicks] = useState<Record<string, StockChoice>>({})
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewErr, setPreviewErr] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const attempt = useRef<VoidAttempt | null>(null)

  const bundle = bundleBlocksPerbaiki(order)
  // Also reloaded after a failed submit: a stock count approved meanwhile adds a counted line that needs a choice.
  const loadPreview = async (isStale: () => boolean = () => false) => {
    try {
      const p = await api.getVoidPreview(order.id)
      if (isStale()) return
      setPreview(p)
      setPreviewErr(null)
    } catch (e: unknown) {
      if (!isStale()) setPreviewErr(e instanceof Error ? e.message : 'Pratinjau pembatalan gagal dimuat.')
    }
  }
  useEffect(() => {
    if (!open) return
    let ignore = false
    void loadPreview(() => ignore)
    return () => { ignore = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, order.id])

  const reset = () => {
    attempt.current = null
    setOpen(false); setReason(null); setNote(''); setChoice('saja'); setTenders(tendersFromOrder(order)); setCustomer(null)
    setPicks({}); setPreview(null); setPreviewErr(null); setConfirming(false); setErr(null)
  }

  const lines = preview?.lines ?? []
  const counted = lines.filter((l) => l.countedAfter)
  const values: VoidFormValues = {
    reason, note, choice, tenders, originalTotal: order.total,
    ...(choice === 'perbaiki' && customer ? { customerId: customer.id } : {}),
    stockChoices: countedChoices(lines, picks),
  }
  const refused = preview && !preview.eligible ? (preview.refusal ?? 'Transaksi ini tidak dapat dibatalkan.') : null

  const askConfirm = () => {
    const problem = voidFormProblem(values)
    if (problem) { setErr(problem); return }
    setErr(null)
    setConfirming(true)
  }

  const submit = async () => {
    setBusy(true)
    attempt.current = nextVoidAttempt(attempt.current, voidAttemptKey(values), () => crypto.randomUUID())
    const res = await submitVoid(api, order.id, voidRequestBody(values, attempt.current.uuid))
    setBusy(false)
    if (res.ok) { reset(); await onDone(); return }
    setConfirming(false)
    setErr(res.message)
    // Picks already made stay; a newly counted line shows up defaulting to restock, and the retry key follows the body.
    await Promise.all([loadPreview(), onDone()])
  }

  if (order.status !== 'completed') return null
  if (!open) {
    return (
      <Button variant="ghost" size="sm" icon={<Ban className="w-3.5 h-3.5" />} onClick={(e) => { e.stopPropagation(); setOpen(true) }}>
        Batalkan Transaksi
      </Button>
    )
  }

  const setTender = (i: number, patch: Partial<TenderInput>) => setTenders((ts) => ts.map((t, j) => (j === i ? { ...t, ...patch } : t)))
  const methodOptions = [...(methods ?? [])].filter((m) => m.isEnabled !== false)
  const sum = tenders.reduce((n, t) => n + t.amount, 0)

  return (
    <div className="space-y-3 rounded-xl border border-paper-2 bg-paper-1 p-4" onClick={(e) => e.stopPropagation()}>
      <p className="text-xs font-black text-ink-500 uppercase tracking-widest">Batalkan transaksi {order.orderNumber}</p>
      {previewErr && <p role="alert" className="text-sm text-danger">{previewErr}</p>}
      {refused && <p role="alert" className="text-sm text-danger">{refused}</p>}

      <Select label="Alasan *" value={reason ?? ''} onChange={(e) => setReason((e.target.value || null) as VoidReasonCode | null)}>
        <option value="">Pilih alasan...</option>
        {VOID_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
      </Select>
      <Textarea label={reason === 'lainnya' ? 'Catatan * (minimal 10 karakter)' : 'Catatan (opsional)'} value={note} rows={2} maxLength={500}
        onChange={(e) => setNote(e.target.value)} />

      <fieldset className="space-y-1.5">
        <legend className="text-xs font-black text-ink-500 uppercase tracking-widest">Pilihan</legend>
        {VOID_CHOICES.map((c) => {
          const blocked = c.value === 'perbaiki' && bundle
          return (
            <label key={c.value} className={`flex items-start gap-2 text-sm ${blocked ? 'opacity-60' : ''}`}>
              <input type="radio" name={`void-choice-${order.id}`} className="mt-1" checked={choice === c.value} disabled={blocked}
                onChange={() => setChoice(c.value)} />
              <span>
                <span className="font-bold text-ink-900">{c.label}</span>
                {c.value === 'perbaiki' && !blocked && (
                  <span className="block text-xs text-ink-700">Ubah metode pembayaran atau pelanggan. Barang tidak berubah dan promosi tetap seperti transaksi asli.</span>
                )}
                {c.value === 'perbaiki' && blocked && (
                  <span className="block text-xs text-warn-strong">Transaksi ini berisi bundle. Buat penggantinya di POS: pilih &quot;Batalkan, pengganti dibuat di POS&quot;.</span>
                )}
              </span>
            </label>
          )
        })}
      </fieldset>

      {choice === 'perbaiki' && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <p className="text-xs font-black text-ink-500 uppercase tracking-widest">Pembayaran pengganti</p>
            {tenders.map((t, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <select aria-label={`Metode pembayaran ${i + 1}`} value={t.method} onChange={(e) => setTender(i, { method: e.target.value })} className={`${fieldClass} h-10 py-0! w-44`}>
                  {!methodOptions.some((m) => m.id === t.method) && <option value={t.method}>{methodLabel(t.method, methods)}</option>}
                  {methodOptions.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
                <AmountField raw={t.amount > 0 ? String(t.amount) : ''} label={`Jumlah pembayaran ${i + 1}`} onRaw={(raw) => setTender(i, { amount: Number(raw || 0) })} />
                {tenders.length > 1 && <Button variant="ghost" size="sm" onClick={() => setTenders((ts) => ts.filter((_, j) => j !== i))}>Hapus</Button>}
              </div>
            ))}
            <div className="flex items-center gap-3">
              <Button variant="secondary" size="sm" onClick={() => setTenders((ts) => [...ts, { method: methodOptions[0]?.id ?? '', amount: 0 }])}>Tambah metode</Button>
              <p className={`text-xs ${Math.round(sum) === Math.round(order.total) ? 'text-ok' : 'text-ink-700'}`}>Jumlah {money(sum)} dari {money(order.total)}</p>
            </div>
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-black text-ink-500 uppercase tracking-widest">Pelanggan pengganti</p>
            {customer ? (
              <div className="flex items-center justify-between rounded-xl border border-paper-2 bg-white px-3 py-2">
                <span className="truncate text-sm font-bold text-ink-900">{customer.name}</span>
                <Button variant="ghost" size="sm" aria-label="Kembali ke pelanggan asli" onClick={() => setCustomer(null)}>Pakai pelanggan asli</Button>
              </div>
            ) : (
              <>
                <p className="text-xs text-ink-700">{order.customerName ? `Pelanggan asli: ${order.customerName}. ` : 'Tanpa pelanggan. '}Cari untuk menggantinya.</p>
                <CustomerSearch onPick={(c) => setCustomer({ id: c.id, name: c.name })} />
              </>
            )}
          </div>
        </div>
      )}

      {counted.length > 0 && (
        <div className="space-y-2 rounded-xl bg-warn-bg p-3">
          <p className="text-sm font-bold text-warn-strong">Stock opname setelah transaksi ini sudah menghitung barang berikut.</p>
          {counted.map((l) => (
            <fieldset key={l.key} className="space-y-1">
              <legend className="text-sm text-ink-900">{l.productName} {l.variantSize} ×{l.quantity}{l.stockCountName ? ` (${l.stockCountName})` : ''}</legend>
              {([['restock', 'kembalikan stok'], ['skip_counted', 'sudah dikoreksi oleh stock opname']] as const).map(([v, label]) => (
                <label key={v} className="flex items-center gap-2 text-sm">
                  <input type="radio" name={`void-stock-${l.key}`} checked={(picks[l.key] ?? 'restock') === v} onChange={() => setPicks((p) => ({ ...p, [l.key]: v }))} />
                  {label}
                </label>
              ))}
            </fieldset>
          ))}
        </div>
      )}

      {err && <p role="alert" className="text-sm text-danger">{err}</p>}
      <div className="flex gap-2">
        <Button variant="secondary" className="flex-1" onClick={reset}>Batal</Button>
        <Button variant="danger" className="flex-1" disabled={!preview || !!refused} onClick={askConfirm}>Lanjut</Button>
      </div>

      <Modal open={confirming} onClose={() => setConfirming(false)} title="Konfirmasi pembatalan" size="sm"
        footer={
          <div className="flex gap-2 w-full">
            <Button variant="secondary" className="flex-1" onClick={() => setConfirming(false)}>Kembali</Button>
            <Button variant="danger" className="flex-1" loading={busy} onClick={() => void submit()}>Batalkan transaksi</Button>
          </div>
        }>
        <div className="space-y-2 text-sm">
          <p>Transaksi {order.orderNumber} ({money(order.total)}) akan dibatalkan. Stok, poin, dan kode diskon dikembalikan.</p>
          <p className="font-bold">{VOID_CHOICES.find((c) => c.value === choice)?.label}</p>
        </div>
      </Modal>
    </div>
  )
}
