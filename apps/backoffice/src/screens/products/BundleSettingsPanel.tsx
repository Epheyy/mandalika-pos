import { useEffect, useMemo, useState } from 'react'
import type { BundleCatalog, BundleSettings } from '@mandalika/api'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { Badge } from '../../ui/Badge'
import { Card } from '../../ui/Card'
import { SaveBar, type SaveBarStatus } from '../../ui/SaveBar'
import { useToast } from '../../ui/Toast'
import { MoneyField } from './MoneyField'
import {
  aromaRows,
  formProblems,
  formToInput,
  saveBundleSettings,
  settingsToForm,
  type BundleSettingsForm,
} from './bundleSettings'

const sizeOf = (f: BundleSettingsForm): string[] => Object.keys(f.standard)

interface StandardPricesCardProps {
  form: BundleSettingsForm
  onChange: (size: string, raw: string) => void
}

function StandardPricesCard({ form, onChange }: StandardPricesCardProps) {
  return (
    <Card className="p-4">
      <h3 className="text-sm font-bold text-ink-900">Harga bundle standar</h3>
      <p className="text-xs text-ink-500 mt-0.5">
        Isi bundle: 1 botol besar + atomizer 10ml + vial 2ml dari lini yang sama. Harga tidak berubah bila 10ml/2ml diganti aroma lain.
      </p>
      <div className="mt-3 space-y-2">
        {sizeOf(form).map((size) => (
          <div key={size} className="flex items-center gap-3">
            <span className="w-16 text-sm text-ink-700">{size}</span>
            <MoneyField className="max-w-48" raw={form.standard[size]} onRawChange={(raw) => onChange(size, raw)} label={`Harga bundle standar ${size}`} placeholder="Rp 0" />
          </div>
        ))}
      </div>
    </Card>
  )
}

interface LinePricesCardProps {
  form: BundleSettingsForm
  lines: BundleSettings['lines']
  onChange: (line: string, size: string, raw: string) => void
}

function LinePricesCard({ form, lines, onChange }: LinePricesCardProps) {
  const sizes = sizeOf(form)
  return (
    <Card className="p-4">
      <h3 className="text-sm font-bold text-ink-900">Harga per lini</h3>
      <p className="text-xs text-ink-500 mt-0.5">Lini diambil dari ERP. Kosong = pakai harga standar.</p>
      {lines.length === 0 ? (
        <p className="mt-3 text-xs text-ink-500">Belum ada lini ERP dengan botol besar di katalog.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-ink-500">
                <th scope="col" className="py-2 pr-3 font-bold">Lini</th>
                {sizes.map((s) => <th key={s} scope="col" className="py-2 pr-3 font-bold">Bundle {s}</th>)}
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.line} className="border-t border-paper-2">
                  <th scope="row" className="py-2 pr-3 text-left font-bold text-ink-900">{l.label}</th>
                  {sizes.map((s) => (
                    <td key={s} className="py-2 pr-3">
                      <MoneyField
                        raw={form.lines[l.line]?.[s] ?? ''}
                        onRawChange={(raw) => onChange(l.line, s, raw)}
                        label={`Harga ${l.label} ${s}`}
                        placeholder="standar"
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

type AromaFilter = 'all' | 'missing'

function BundleAromaList({ catalog }: { catalog: BundleCatalog }) {
  const [filter, setFilter] = useState<AromaFilter>('all')
  const rows = useMemo(() => aromaRows(catalog, filter), [catalog, filter])
  const filterBtn = (id: AromaFilter, text: string) => (
    <button
      type="button"
      aria-pressed={filter === id}
      onClick={() => setFilter(id)}
      className={`rounded-md px-2 py-0.5 text-[11px] font-bold ${filter === id ? 'bg-ink-900 text-white' : 'bg-paper-1 text-ink-700'}`}
    >
      {text}
    </button>
  )
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-bold text-ink-900">Aroma yang punya bundle</h3>
        <div className="flex items-center gap-1.5 text-[11px] text-ink-500">
          Filter: {filterBtn('all', 'Semua')}{filterBtn('missing', 'Ada yang kurang')}
        </div>
      </div>
      <p className="text-xs text-ink-500 mt-0.5">Otomatis dari katalog: satu bundle per lini dan ukuran besar, bila atomizer 10ml dan 2ml lini itu ada.</p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-ink-500">
              <th scope="col" className="py-2 pr-3 font-bold">Aroma</th>
              <th scope="col" className="py-2 pr-3 font-bold">Bundle</th>
              <th scope="col" className="py-2 font-bold">Catatan</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.productId} className="border-t border-paper-2 align-top">
                <th scope="row" className="py-2 pr-3 text-left font-bold text-ink-900">{r.name}</th>
                <td className="py-2 pr-3">
                  {r.offers.length === 0 ? (
                    <span className="text-xs text-ink-500">Tidak ada bundle</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">{r.offers.map((o) => <Badge key={o.key} tone="success">{o.text}</Badge>)}</div>
                  )}
                </td>
                <td className="py-2">
                  {r.notes.length === 0 ? (
                    <span className="text-xs text-ink-500">—</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">{r.notes.map((n) => <Badge key={n.key} tone="danger">{n.text}</Badge>)}</div>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={3} className="py-4 text-center text-xs text-ink-500">{filter === 'missing' ? 'Semua aroma lengkap.' : 'Belum ada aroma dengan botol besar.'}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

/** Produk › Bundle: standard and per-line bundle prices, plus the automatic list of bundles. */
export function BundleSettingsPanel() {
  const toast = useToast()
  const sq = usePolledQuery(() => api.getBundleSettings(), [])
  const cq = usePolledQuery(() => api.getBundleCatalog(), [])
  const loaded = sq.data?.data
  const [saved, setSaved] = useState<BundleSettingsForm | null>(null)
  const [form, setForm] = useState<BundleSettingsForm | null>(null)
  const [status, setStatus] = useState<SaveBarStatus>('idle')
  const [message, setMessage] = useState<string | undefined>()

  // The form starts from the first load only: later polls must not overwrite what is being typed.
  useEffect(() => {
    if (loaded && form === null) {
      const f = settingsToForm(loaded)
      setSaved(f)
      setForm(f)
    }
  }, [loaded, form])

  if (sq.error && !loaded) return <p role="alert" className="text-sm text-danger">Harga bundle gagal dimuat.</p>
  if (!loaded || !form || !saved) return <p className="text-sm text-ink-500">Memuat harga bundle…</p>

  const dirty = JSON.stringify(formToInput(form)) !== JSON.stringify(formToInput(saved))
  const edit = (next: BundleSettingsForm) => {
    setForm(next)
    setStatus('idle')
  }
  const onStandard = (size: string, raw: string) => edit({ ...form, standard: { ...form.standard, [size]: raw } })
  const onLine = (line: string, size: string, raw: string) =>
    edit({ ...form, lines: { ...form.lines, [line]: { ...form.lines[line], [size]: raw } } })

  const save = async () => {
    setStatus('saving')
    const r = await saveBundleSettings(api, form)
    if (!r.ok) {
      setStatus('error')
      setMessage(r.error)
      return
    }
    setSaved(form)
    setStatus('saved')
    setMessage('Harga bundle disimpan. Tablet memakainya setelah sinkron berikutnya.')
    toast({ message: 'Harga bundle disimpan.', tone: 'ok' })
    void cq.refetch()
  }

  const problems = formProblems(form)
  return (
    <div className="space-y-3">
      <StandardPricesCard form={form} onChange={onStandard} />
      <LinePricesCard form={form} lines={loaded.lines} onChange={onLine} />
      {problems.length > 0 && <p role="alert" className="text-xs font-bold text-danger">{problems[0]}</p>}
      {cq.data ? <BundleAromaList catalog={cq.data.data} /> : <p className="text-sm text-ink-500">{cq.error ? 'Daftar bundle gagal dimuat.' : 'Memuat daftar bundle…'}</p>}
      <SaveBar
        count={dirty ? 1 : 0}
        items={['Harga bundle']}
        status={status}
        message={message}
        onSave={() => void save()}
        onDiscard={() => {
          setForm(saved)
          setStatus('idle')
        }}
      />
    </div>
  )
}
