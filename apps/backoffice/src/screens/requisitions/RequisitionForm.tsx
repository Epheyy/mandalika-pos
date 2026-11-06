import { useMemo, useRef, useState } from 'react'
import { fetchAllPages, type Product, type StockRequisition, type StockRequisitionInput } from '@mandalika/api'
import { variantLabel } from '@mandalika/types'
import { ArrowLeft, Plus, Save, Trash2 } from 'lucide-react'
import { api } from '../../api'
import { useAuth } from '../../auth'
import { useOutlet } from '../../outlet'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { IconButton } from '../../ui/IconButton'
import { Input, Select, Textarea, fieldClass } from '../../ui/Field'
import { PageHeader } from '../../ui/PageHeader'

interface Line {
  productId: string
  productName: string
  variantSize: string
  qty: string
}

interface RequisitionFormProps {
  /** Present when editing a draft; absent when creating. */
  draft?: StockRequisition
  onCancel: () => void
  onSaved: (id: string) => void
}

const lineKey = (l: Pick<Line, 'productId' | 'variantSize'>) => `${l.productId}|${l.variantSize}`

function initialLines(draft?: StockRequisition): Line[] {
  return (draft?.items ?? []).map((it) => ({
    productId: it.productId,
    productName: it.productName ?? it.productId,
    variantSize: it.variantSize,
    qty: String(it.requestedQty),
  }))
}

/** Create or edit a draft Permintaan Barang: pick SKUs (product + size) and a qty per line. */
export function RequisitionForm({ draft, onCancel, onSaved }: RequisitionFormProps) {
  const { user } = useAuth()
  const { outletId } = useOutlet()
  const activeOutlet = user?.role === 'admin' ? outletId : (user?.outletId ?? null)
  const pq = usePolledQuery<Product[]>(() => fetchAllPages((page, limit) => api.listProducts(page, limit)), [], 600000)
  const [lines, setLines] = useState<Line[]>(() => initialLines(draft))
  const [note, setNote] = useState(draft?.note ?? '')
  const [neededBy, setNeededBy] = useState(draft?.neededBy ?? '')
  const [search, setSearch] = useState('')
  const [pickKey, setPickKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // One Idempotency-Key per form content: a retry after a lost response replays the same write.
  // Only an edit (a different content signature) mints a new key.
  const attempt = useRef<{ sig: string; key: string } | null>(null)
  const keyFor = (sig: string): string => {
    if (attempt.current?.sig !== sig) attempt.current = { sig, key: crypto.randomUUID() }
    return attempt.current.key
  }

  const options = useMemo(() => {
    const q = search.trim().toLowerCase()
    const out: Array<{ key: string; label: string; line: Omit<Line, 'qty'> }> = []
    for (const p of pq.data ?? []) {
      if (!p.id || !p.isActive) continue
      if (q && !p.name.toLowerCase().includes(q) && !p.variants.some((v) => v.sku?.toLowerCase().includes(q))) continue
      for (const v of p.variants) {
        const line = { productId: p.id, productName: p.name, variantSize: v.size }
        out.push({ key: lineKey(line), label: `${p.name} · ${variantLabel(v.size)}${v.sku ? ` (${v.sku})` : ''}`, line })
      }
    }
    return out.slice(0, 200)
  }, [pq.data, search])

  const addLine = () => {
    const opt = options.find((o) => o.key === pickKey)
    if (!opt) return
    if (lines.some((l) => lineKey(l) === opt.key)) {
      setErr('SKU ini sudah ada di daftar; ubah qty-nya saja.')
      return
    }
    setErr(null)
    setLines((ls) => [...ls, { ...opt.line, qty: '1' }])
    setPickKey('')
  }

  const save = async () => {
    const items = lines.map((l) => ({ productId: l.productId, variantSize: l.variantSize, requestedQty: Number(l.qty) }))
    if (items.length === 0) return setErr('Tambahkan minimal satu barang.')
    if (items.some((i) => !Number.isInteger(i.requestedQty) || i.requestedQty <= 0)) return setErr('Qty harus bilangan bulat lebih dari 0.')
    const input: StockRequisitionInput = { items, note: note.trim() || undefined, neededBy: neededBy || undefined }
    const key = keyFor(JSON.stringify({ activeOutlet, draftId: draft?.id ?? null, input }))
    setBusy(true)
    setErr(null)
    try {
      const saved = draft
        ? await api.updateRequisition(draft.id, input, key)
        : await api.createRequisition(input, key)
      onSaved(saved.id)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal menyimpan permintaan.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={draft ? `Ubah ${draft.number}` : 'Permintaan Barang Baru'}
        subtitle="Minta barang dari gudang untuk outlet ini"
        actions={
          <>
            <Button variant="secondary" icon={<ArrowLeft className="w-4 h-4" />} onClick={onCancel}>Kembali</Button>
            <Button icon={<Save className="w-4 h-4" />} loading={busy} onClick={save}>
              {busy ? 'Menyimpan...' : 'Simpan Draf'}
            </Button>
          </>
        }
      />

      <Card className="p-5 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Dibutuhkan pada" type="date" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} />
        </div>
        <Textarea label="Catatan" rows={2} placeholder="Opsional" value={note} onChange={(e) => setNote(e.target.value)} />
      </Card>

      <Card className="p-5 space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[200px] flex-1">
            <Input label="Cari produk / SKU" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Ketik nama atau SKU" />
          </div>
          <div className="min-w-[260px] flex-[2]">
            <Select label="Barang" value={pickKey} onChange={(e) => setPickKey(e.target.value)}>
              <option value="">{pq.loading ? 'Memuat produk…' : 'Pilih barang…'}</option>
              {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </Select>
          </div>
          <Button variant="secondary" icon={<Plus className="w-4 h-4" />} onClick={addLine} disabled={!pickKey}>Tambah</Button>
        </div>

        {lines.length === 0 ? (
          <p className="text-sm text-ink-500">Belum ada barang.</p>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-paper-2 bg-paper-1">
                {['Produk', 'Ukuran', 'Qty diminta', ''].map((h) => (
                  <th key={h} className="text-left px-4 py-2 text-xs font-black text-ink-700 uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-paper-2">
              {lines.map((l) => (
                <tr key={lineKey(l)}>
                  <td className="px-4 py-2 text-sm font-bold text-ink-900">{l.productName}</td>
                  <td className="px-4 py-2 text-sm text-ink-700">{variantLabel(l.variantSize)}</td>
                  <td className="px-4 py-2 w-40">
                    <input
                      type="number" min={1} value={l.qty} className={`${fieldClass} py-1.5`}
                      aria-label={`Qty diminta ${l.productName} ${l.variantSize}`}
                      onChange={(e) => setLines((ls) => ls.map((x) => (lineKey(x) === lineKey(l) ? { ...x, qty: e.target.value } : x)))}
                    />
                  </td>
                  <td className="px-4 py-2 text-right">
                    <IconButton tone="danger" label={`Hapus ${l.productName} ${l.variantSize}`}
                      onClick={() => setLines((ls) => ls.filter((x) => lineKey(x) !== lineKey(l)))}>
                      <Trash2 className="w-4 h-4" />
                    </IconButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {err && <p className="text-sm text-danger">{err}</p>}
      </Card>
    </div>
  )
}
