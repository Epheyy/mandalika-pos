import type { ReceiptTemplate } from '@mandalika/api'
import { RECEIPT_LIMITS, type PaperWidth } from '@mandalika/printer/render'
import { Button } from '../../../ui/Button'
import { Card } from '../../../ui/Card'
import { BlockList } from './BlockList'
import { pendingAdjustments, type DesignerAction, type DesignerState } from './designerReducer'
import { ReceiptPaper } from './ReceiptPaper'
import { ADJUSTED_NOTICE, UNUSABLE_TEMPLATE_COPY, describeAdjustment } from './receiptTemplates'
import { TemplateBar } from './TemplateBar'
import type { AddableBlock } from './designerReducer'

export interface Notice {
  tone: 'error' | 'ok'
  text: string
  /** Offered with the stale-save message: load the server copy. */
  reload?: boolean
}

export interface StrukViewProps {
  state: DesignerState
  dispatch: (a: DesignerAction) => void
  templates: readonly ReceiptTemplate[]
  showVirtualStandar: boolean
  unusable: ReadonlySet<string>
  selectedKey: string
  usedBy: number | null
  notice: Notice | null
  saving: boolean
  addOpen: boolean
  onToggleAdd: () => void
  onSelect: (key: string) => void
  onNew: () => void
  onDuplicate: () => void
  onRename: () => void
  onDelete: () => void
  onAssign: () => void
  onSave: () => void
  onReload: () => void
}

const ADD_CHOICES: ReadonlyArray<{ block: AddableBlock; label: string }> = [
  { block: 'text', label: 'Teks' },
  { block: 'divider', label: 'Garis' },
  { block: 'points', label: 'Poin member' },
  { block: 'transaction', label: 'Info transaksi' },
  { block: 'header', label: 'Judul & info outlet' },
]

/** The designer screen without its data fetching: block list and editor on the left, paper preview on the right. */
export function StrukView(p: StrukViewProps) {
  const { state } = p
  const adjustments = pendingAdjustments(state)
  const atLimit = state.layout.blocks.length >= RECEIPT_LIMITS.blocksMax
  const warned = state.templateId !== null && p.unusable.has(state.templateId)
  return (
    <div className="max-w-6xl space-y-4">
      <Card className="space-y-4 p-5">
        <div>
          <h2 className="text-lg font-black text-ink-900">Desain Struk</h2>
          <p className="text-xs text-ink-700">Pengaturan › Struk. Berlaku untuk outlet yang memakai template ini; tablet mengambilnya saat sinkron berikutnya.</p>
        </div>
        <TemplateBar
          templates={p.templates}
          showVirtualStandar={p.showVirtualStandar}
          unusable={p.unusable}
          selectedKey={p.selectedKey}
          paperWidth={state.layout.paperWidth}
          usedBy={p.usedBy}
          canDelete={state.templateId !== null && !state.isDefault}
          onSelect={p.onSelect}
          onNew={p.onNew}
          onDuplicate={p.onDuplicate}
          onRename={p.onRename}
          onDelete={p.onDelete}
          onWidth={(paperWidth: PaperWidth) => p.dispatch({ type: 'setWidth', paperWidth })}
          onAssign={p.onAssign}
        />
        {warned && <p role="alert" data-testid="unusable-warning" className="rounded-xl bg-warn-bg px-3 py-2 text-xs font-bold text-warn-strong">{UNUSABLE_TEMPLATE_COPY}</p>}
        {adjustments.length > 0 && (
          <div data-testid="adjustments" className="rounded-xl bg-warn-bg px-3 py-2 text-xs text-warn-strong">
            <p className="font-bold">{ADJUSTED_NOTICE}</p>
            <ul className="mt-1 list-disc pl-4">
              {adjustments.map((a, i) => (
                <li key={`${a.blockId}-${a.kind}-${i}`}>{describeAdjustment(a)}</li>
              ))}
            </ul>
          </div>
        )}
        {p.notice && (
          <div role="alert" className={`flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-bold ${p.notice.tone === 'error' ? 'bg-danger-bg text-danger' : 'bg-ok-bg text-ok'}`}>
            <p className="flex-1">{p.notice.text}</p>
            {p.notice.reload && <Button size="sm" variant="secondary" onClick={p.onReload}>Muat ulang</Button>}
          </div>
        )}
      </Card>

      <div inert={p.saving} aria-busy={p.saving} className="grid items-start gap-4 xl:grid-cols-[1.15fr_1fr]">
        <Card className="p-4">
          <h3 className="font-black text-ink-900">Blok struk</h3>
          <p className="text-xs text-ink-700">Seret untuk mengubah urutan. Blok bergembok selalu dicetak.</p>
          <BlockList blocks={state.layout.blocks} editingId={state.editingId} dispatch={p.dispatch} />
          {p.addOpen ? (
            <div className="mt-2 flex flex-wrap gap-2 rounded-xl border border-dashed border-brand-strong p-2">
              {ADD_CHOICES.map((c) => (
                <Button key={c.block} size="sm" variant="secondary" onClick={() => { p.dispatch({ type: 'add', block: c.block }); p.onToggleAdd() }}>{c.label}</Button>
              ))}
              <Button size="sm" variant="ghost" onClick={p.onToggleAdd}>Batal</Button>
            </div>
          ) : (
            <button
              type="button"
              disabled={atLimit}
              onClick={p.onToggleAdd}
              className="mt-2 w-full rounded-xl border border-dashed border-brand-strong p-2 text-sm font-bold text-brand-strong hover:bg-warn-bg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-strong disabled:cursor-not-allowed disabled:opacity-50"
            >
              + Tambah blok
            </button>
          )}
          {atLimit && <p className="mt-1 text-xs text-ink-700">Maksimal {RECEIPT_LIMITS.blocksMax} blok.</p>}
        </Card>

        <Card className="p-4">
          <h3 className="mb-3 font-black text-ink-900">Pratinjau</h3>
          <ReceiptPaper layout={state.layout} />
          <p className="mt-2 text-center text-[11px] text-ink-700">Contoh transaksi. Pratinjau digambar oleh kode yang sama dengan printer.</p>
          <div className="mt-3 flex justify-center gap-2">
            <Button loading={p.saving} onClick={p.onSave} disabled={!state.dirty && state.templateId !== null}>Simpan</Button>
          </div>
        </Card>
      </div>
    </div>
  )
}
