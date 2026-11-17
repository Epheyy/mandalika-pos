import type { CSSProperties } from 'react'
import { DndContext, KeyboardSensor, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, Lock, Trash2 } from 'lucide-react'
import { NEW_TEMPLATE_BLOCKS, isLockedType, type ReceiptBlock, type ReceiptBlockType } from '@mandalika/printer/render'
import { IconButton } from '../../../ui/IconButton'
import { Switch } from '../../../ui/Switch'
import { cn } from '../../../ui/cn'
import { BlockEditor } from './BlockEditor'
import type { DesignerAction } from './designerReducer'

export const BLOCK_NAMES: Record<ReceiptBlockType, string> = {
  header: 'Judul & info outlet',
  transaction: 'Info transaksi',
  items: 'Daftar barang',
  totals: 'Diskon & total',
  payment: 'Pembayaran & kembalian',
  points: 'Poin member',
  text: 'Teks',
  divider: 'Garis',
}

const BLOCK_HINTS: Partial<Record<ReceiptBlockType, string>> = {
  header: 'judul, nama, alamat, telepon',
  transaction: 'no., tanggal, kasir, pelanggan',
  points: 'perkiraan poin member',
}

const LOCK_BADGE: Partial<Record<ReceiptBlockType, string>> = { items: 'wajib', totals: 'total wajib', payment: 'wajib' }

const STARTER_IDS: ReadonlySet<string> = new Set(NEW_TEMPLATE_BLOCKS.map((b) => b.id))

/** Locked blocks and the starter blocks of a new template are switched off, not deleted. */
export const canDelete = (b: ReceiptBlock): boolean => !isLockedType(b.type) && !STARTER_IDS.has(b.id)

const blockTitle = (b: ReceiptBlock): string => (b.type === 'text' && b.label ? b.label : BLOCK_NAMES[b.type])

interface RowProps {
  block: ReceiptBlock
  selected: boolean
  dispatch: (a: DesignerAction) => void
}

function BlockRow({ block, selected, dispatch }: RowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: block.id })
  const style: CSSProperties = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 }
  const locked = isLockedType(block.type)
  const name = blockTitle(block)
  return (
    <li ref={setNodeRef} style={style} data-block-id={block.id}>
      <div
        className={cn(
          'mt-1.5 flex items-center gap-2 rounded-xl border bg-white px-2 py-1.5',
          selected ? 'border-2 border-brand-strong bg-warn-bg' : 'border-paper-2',
          !block.enabled && 'bg-paper-1 text-ink-700',
        )}
      >
        <button
          type="button"
          aria-label={`Geser blok ${name}`}
          className="flex h-8 w-6 flex-shrink-0 cursor-grab touch-none items-center justify-center rounded text-ink-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-strong"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-expanded={selected}
          onClick={() => dispatch({ type: 'select', id: selected ? null : block.id })}
          className="flex min-w-0 flex-1 items-baseline gap-2 rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-strong"
        >
          <span className="truncate text-sm font-bold text-ink-900">{name}</span>
          {BLOCK_HINTS[block.type] && <span className="hidden truncate text-[11px] text-ink-700 sm:inline">{BLOCK_HINTS[block.type]}</span>}
        </button>
        {locked ? (
          <span data-testid="lock-badge" className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-paper-2 px-1.5 py-0.5 text-[10.5px] font-bold text-ink-700">
            <Lock className="h-3 w-3" aria-hidden="true" />
            {LOCK_BADGE[block.type]}
          </span>
        ) : (
          <Switch label={`Tampilkan ${name}`} size="sm" checked={block.enabled} onChange={() => dispatch({ type: 'toggle', id: block.id })} />
        )}
        {canDelete(block) && (
          <IconButton tone="danger" label={`Hapus blok ${name}`} onClick={() => dispatch({ type: 'remove', id: block.id })}>
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </IconButton>
        )}
      </div>
      {selected && <BlockEditor block={block} onChange={(patch) => dispatch({ type: 'edit', id: block.id, patch })} />}
    </li>
  )
}

interface BlockListProps {
  blocks: readonly ReceiptBlock[]
  editingId: string | null
  dispatch: (a: DesignerAction) => void
}

/** The sortable block list. Drag with the grip, or focus it and use Space, the arrow keys and Space. */
export function BlockList({ blocks, editingId, dispatch }: BlockListProps) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return
    const from = blocks.findIndex((b) => b.id === e.active.id)
    const to = blocks.findIndex((b) => b.id === e.over!.id)
    if (from >= 0 && to >= 0) dispatch({ type: 'move', from, to })
  }
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={blocks.map((b) => b.id)} strategy={verticalListSortingStrategy}>
        <ul aria-label="Blok struk">
          {blocks.map((b) => (
            <BlockRow key={b.id} block={b} selected={editingId === b.id} dispatch={dispatch} />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  )
}
