import { useState } from 'react'
import type { Tag } from '@mandalika/api'
import { Trash2, Plus, Check, X } from 'lucide-react'
import { api } from '../../api'
import { Button, Input } from '../../ui'
import { TAG_COLORS, tagChipClasses } from './tagColors'

interface TagManagerProps {
  tags: Tag[]
  onChange: () => void // refetch tags after any mutation
}

function ColorPicker({ value, onPick }: { value: string; onPick: (c: string) => void }) {
  return (
    <div className="flex gap-1 flex-wrap">
      {TAG_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onPick(c)}
          aria-label={`Warna ${c}`}
          className={`w-6 h-6 rounded-full border-2 ${tagChipClasses(c)} ${value === c ? 'ring-2 ring-offset-1 ring-gray-500' : ''}`}
        />
      ))}
    </div>
  )
}

export function TagManager({ tags, onChange }: TagManagerProps) {
  const [name, setName] = useState('')
  const [color, setColor] = useState<string>('amber')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [editId, setEditId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState('amber')
  const [confirmDelete, setConfirmDelete] = useState<Tag | null>(null)

  const create = async () => {
    if (!name.trim()) { setErr('Nama tag wajib'); return }
    setBusy(true); setErr(null)
    try {
      await api.createTag({ name: name.trim(), color })
      setName(''); setColor('amber'); onChange()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal membuat tag.')
    } finally { setBusy(false) }
  }

  const saveEdit = async (id: string) => {
    if (!editName.trim()) return
    setBusy(true); setErr(null)
    try {
      await api.updateTag(id, { name: editName.trim(), color: editColor })
      setEditId(null); onChange()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal menyimpan tag.')
    } finally { setBusy(false) }
  }

  const del = async (id: string) => {
    setBusy(true); setErr(null)
    try { await api.deleteTag(id); setConfirmDelete(null); onChange() }
    catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Gagal menghapus tag.') }
    finally { setBusy(false) }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Input label="Tag baru" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nama tag" />
        <ColorPicker value={color} onPick={setColor} />
        <Button size="sm" icon={<Plus className="w-4 h-4" />} loading={busy} onClick={() => void create()}>Tambah Tag</Button>
      </div>
      {err && <p className="text-xs text-red-600">{err}</p>}
      <ul className="space-y-1">
        {tags.map((t) => (
          <li key={t.id} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg bg-gray-50">
            {editId === t.id ? (
              <div className="flex-1 space-y-1.5">
                <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
                <ColorPicker value={editColor} onPick={setEditColor} />
                <div className="flex gap-1">
                  <Button size="sm" icon={<Check className="w-3.5 h-3.5" />} loading={busy} onClick={() => void saveEdit(t.id)}>Simpan</Button>
                  <Button size="sm" variant="secondary" icon={<X className="w-3.5 h-3.5" />} onClick={() => setEditId(null)}>Batal</Button>
                </div>
              </div>
            ) : (
              <>
                <span className={`px-2 py-0.5 rounded-full text-xs font-bold border ${tagChipClasses(t.color)}`}>{t.name}</span>
                <div className="flex items-center gap-1">
                  <button type="button" className="text-xs text-gray-500 hover:text-gray-900" onClick={() => { setEditId(t.id); setEditName(t.name); setEditColor(t.color) }}>Edit</button>
                  <button type="button" aria-label={`Hapus tag ${t.name}`} className="p-1 text-gray-400 hover:text-red-500" onClick={() => setConfirmDelete(t)}><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
      {confirmDelete && (
        <div className="p-3 rounded-xl border border-red-200 bg-red-50 space-y-2">
          <p className="text-xs text-gray-700">Hapus tag <strong>&ldquo;{confirmDelete.name}&rdquo;</strong>? Tag akan dilepas dari semua pelanggan.</p>
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1 text-xs py-1.5" onClick={() => setConfirmDelete(null)} disabled={busy}>Batal</Button>
            <Button variant="danger" className="flex-1 text-xs py-1.5" loading={busy} onClick={() => void del(confirmDelete.id)}>Hapus</Button>
          </div>
        </div>
      )}
    </div>
  )
}
