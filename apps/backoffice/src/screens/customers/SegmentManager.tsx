import { useState } from 'react'
import type { Segment, SegmentInput } from '@mandalika/api'
import { Trash2, Plus, ChevronUp, ChevronDown } from 'lucide-react'
import { api } from '../../api'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Field'
import { TAG_COLORS, tagChipClasses } from './tagColors'

interface SegmentManagerProps {
  segments: Segment[]
  onChange: () => void // refetch after any mutation
}

const EMPTY: SegmentInput = { name: '', color: 'blue', isActive: true }

function ColorPicker({ value, onPick }: { value: string; onPick: (c: string) => void }) {
  return (
    <div className="flex gap-1 flex-wrap">
      {TAG_COLORS.map((c) => (
        <button key={c} type="button" onClick={() => onPick(c)} aria-label={`Warna ${c}`}
          className={`w-6 h-6 rounded-full border-2 ${tagChipClasses(c)} ${value === c ? 'ring-2 ring-offset-1 ring-gray-500' : ''}`} />
      ))}
    </div>
  )
}

type BoundKey = 'rMin' | 'rMax' | 'fMin' | 'fMax' | 'mMin' | 'mMax'
function numPatch(key: BoundKey, v: string): Partial<SegmentInput> {
  return { [key]: v === '' ? null : Number(v) }
}

// Bounds editor: six optional number inputs (R/F/M min/max).
function Bounds({ form, set }: { form: SegmentInput; set: (patch: Partial<SegmentInput>) => void }) {
  const row = (label: string, minKey: BoundKey, maxKey: BoundKey) => (
    <div className="flex items-center gap-2">
      <span className="text-xs font-bold text-gray-500 w-28">{label}</span>
      <Input type="number" placeholder="min" value={(form[minKey] as number | null) ?? ''} onChange={(e) => set(numPatch(minKey, e.target.value))} />
      <Input type="number" placeholder="max" value={(form[maxKey] as number | null) ?? ''} onChange={(e) => set(numPatch(maxKey, e.target.value))} />
    </div>
  )
  return (
    <div className="space-y-1.5">
      {row('Recency (hari)', 'rMin', 'rMax')}
      {row('Frequency (kunjungan)', 'fMin', 'fMax')}
      {row('Monetary (belanja)', 'mMin', 'mMax')}
    </div>
  )
}

export function SegmentManager({ segments, onChange }: SegmentManagerProps) {
  const [form, setForm] = useState<SegmentInput>(EMPTY)
  const [editId, setEditId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Segment | null>(null)
  const set = (patch: Partial<SegmentInput>) => setForm((f) => ({ ...f, ...patch }))

  const save = async () => {
    if (!form.name.trim()) { setErr('Nama segmen wajib'); return }
    setBusy(true); setErr(null)
    try {
      if (editId) await api.updateSegment(editId, form)
      else await api.createSegment(form)
      setForm(EMPTY); setEditId(null); onChange()
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Gagal menyimpan segmen.') }
    finally { setBusy(false) }
  }
  const startEdit = (s: Segment) => {
    setEditId(s.id)
    setForm({ name: s.name, color: s.color, rMin: s.rMin, rMax: s.rMax, fMin: s.fMin, fMax: s.fMax, mMin: s.mMin, mMax: s.mMax, isActive: s.isActive })
  }
  const del = async (id: string) => {
    setBusy(true)
    try { await api.deleteSegment(id); setConfirmDelete(null); onChange() }
    catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Gagal menghapus.') }
    finally { setBusy(false) }
  }
  const move = async (idx: number, dir: -1 | 1) => {
    const next = [...segments]
    const j = idx + dir
    if (j < 0 || j >= next.length) return
    ;[next[idx], next[j]] = [next[j], next[idx]]
    setBusy(true); setErr(null)
    try {
      await api.reorderSegments(next.map((s) => s.id))
      onChange()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal mengubah urutan.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2 p-3 rounded-xl border border-gray-100">
        <p className="text-xs font-bold text-gray-700">{editId ? 'Edit Segmen' : 'Segmen Baru'}</p>
        <Input label="Nama" value={form.name} onChange={(e) => set({ name: e.target.value })} />
        <ColorPicker value={form.color} onPick={(c) => set({ color: c })} />
        <Bounds form={form} set={set} />
        <label className="flex items-center gap-2 text-xs font-bold text-gray-600">
          <input type="checkbox" checked={form.isActive ?? true} onChange={(e) => set({ isActive: e.target.checked })} className="accent-gold-600" /> Aktif
        </label>
        {err && <p className="text-xs text-red-600">{err}</p>}
        <div className="flex gap-2">
          <Button size="sm" icon={<Plus className="w-4 h-4" />} loading={busy} onClick={() => void save()}>{editId ? 'Simpan' : 'Tambah'}</Button>
          {editId && <Button size="sm" variant="secondary" onClick={() => { setEditId(null); setForm(EMPTY) }}>Batal</Button>}
        </div>
      </div>
      <p className="text-[11px] text-gray-400">Urutan = prioritas (cocok pertama menang).</p>
      <ul className="space-y-1">
        {segments.map((s, i) => (
          <li key={s.id} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg bg-gray-50">
            <span className={`px-2 py-0.5 rounded-full text-xs font-bold border ${tagChipClasses(s.color)} ${s.isActive ? '' : 'opacity-40'}`}>{s.name}</span>
            <div className="flex items-center gap-1">
              <button type="button" aria-label="Naik" disabled={busy || i === 0} onClick={() => void move(i, -1)} className="p-1 text-gray-400 hover:text-gray-700 disabled:opacity-30"><ChevronUp className="w-3.5 h-3.5" /></button>
              <button type="button" aria-label="Turun" disabled={busy || i === segments.length - 1} onClick={() => void move(i, 1)} className="p-1 text-gray-400 hover:text-gray-700 disabled:opacity-30"><ChevronDown className="w-3.5 h-3.5" /></button>
              <button type="button" className="text-xs text-gray-500 hover:text-gray-900" onClick={() => startEdit(s)}>Edit</button>
              <button type="button" aria-label={`Hapus ${s.name}`} className="p-1 text-gray-400 hover:text-red-500" onClick={() => setConfirmDelete(s)}><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          </li>
        ))}
      </ul>
      {confirmDelete && (
        <div className="p-3 rounded-xl border border-red-200 bg-red-50 space-y-2">
          <p className="text-xs text-gray-700">Hapus segmen <strong>&ldquo;{confirmDelete.name}&rdquo;</strong>? Pelanggan akan dihitung ulang ke segmen lain.</p>
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1 text-xs py-1.5" onClick={() => setConfirmDelete(null)} disabled={busy}>Batal</Button>
            <Button variant="danger" className="flex-1 text-xs py-1.5" loading={busy} onClick={() => void del(confirmDelete.id)}>Hapus</Button>
          </div>
        </div>
      )}
    </div>
  )
}
