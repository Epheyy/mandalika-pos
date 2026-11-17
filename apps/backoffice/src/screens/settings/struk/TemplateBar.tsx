import type { PaperWidth } from '@mandalika/printer/render'
import type { ReceiptTemplate } from '@mandalika/api'
import { Button } from '../../../ui/Button'
import { Select } from '../../../ui/Field'
import { Seg } from './BlockEditor'

export const VIRTUAL_KEY = 'standar-virtual'

interface TemplateBarProps {
  templates: readonly ReceiptTemplate[]
  showVirtualStandar: boolean
  /** Ids of templates the tablet would refuse. */
  unusable: ReadonlySet<string>
  /** The select value: a template id, or VIRTUAL_KEY. */
  selectedKey: string
  paperWidth: PaperWidth
  /** "Dipakai di N outlet", or null while the template is unsaved. */
  usedBy: number | null
  /** Hapus is off for Standar. */
  canDelete: boolean
  onSelect: (key: string) => void
  onNew: () => void
  onDuplicate: () => void
  onRename: () => void
  onDelete: () => void
  onWidth: (w: PaperWidth) => void
  onAssign: () => void
}

/** Template select and actions, the paper width and the outlet count: the top row of the mockup. */
export function TemplateBar(p: TemplateBarProps) {
  const options = [
    ...(p.showVirtualStandar ? [{ key: VIRTUAL_KEY, label: 'Standar' }] : []),
    ...p.templates.map((t) => ({ key: t.id, label: `${t.name}${p.unusable.has(t.id) ? ' ⚠' : ''}` })),
  ]
  const known = options.some((o) => o.key === p.selectedKey)
  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
      <div className="min-w-44">
        <Select label="Template" value={p.selectedKey} onChange={(e) => p.onSelect(e.target.value)}>
          {!known && <option value={p.selectedKey}>Template baru</option>}
          {options.map((o) => (
            <option key={o.key} value={o.key}>{o.label}</option>
          ))}
        </Select>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={p.onNew}>Template baru</Button>
        <Button size="sm" variant="secondary" onClick={p.onDuplicate}>Duplikat</Button>
        <Button size="sm" variant="secondary" onClick={p.onRename}>Ganti nama</Button>
        <Button size="sm" variant="secondary" onClick={p.onDelete} disabled={!p.canDelete} title={p.canDelete ? undefined : 'Template Standar tidak bisa dihapus.'}>Hapus</Button>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-bold text-ink-700">Kertas</span>
        <Seg
          label="Lebar kertas"
          value={p.paperWidth}
          options={[{ value: 58, label: '58mm' }, { value: 80, label: '80mm' }]}
          onChange={p.onWidth}
        />
      </div>
      <Button size="sm" variant="secondary" onClick={p.onAssign} disabled={p.usedBy === null}>
        {p.usedBy === null ? 'Simpan dulu untuk memilih outlet' : `Dipakai di ${p.usedBy} outlet`}
      </Button>
    </div>
  )
}
