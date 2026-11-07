import { useState, type CSSProperties, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Columns3 } from 'lucide-react'
import { Button } from './Button'
import { cn } from './cn'
import { useHorizontalOverflow } from './useHorizontalOverflow'

export interface Column<Row> {
  /** Stable; also the column-chooser key. */
  id: string
  /** Exact accessible name (no sort text inside it). */
  header: string
  cell: (row: Row) => ReactNode
  /** Money and quantities: right-aligned, tabular figures. */
  align?: 'left' | 'right'
  width?: number | string
  /** Leading columns only. Offsets are summed from numeric widths (px). */
  sticky?: boolean
  /** Two-row header: contiguous columns with the same group share one cell. */
  group?: string
  /** Default true unless sticky. */
  hideable?: boolean
  defaultHidden?: boolean
  /** Server sort field; undefined = not sortable. */
  sortKey?: string
}

export interface SortState {
  key: string
  dir: 'asc' | 'desc'
}

export interface DataTableProps<Row> {
  /** Visually hidden <caption>. */
  caption: string
  columns: Column<Row>[]
  rows: readonly Row[]
  rowKey: (row: Row) => string
  /** Skeleton rows, header kept. */
  loading?: boolean
  /** Shown once as role="alert" inside the card. */
  error?: string | null
  onRetry?: () => void
  empty?: ReactNode
  /** The <tr> handles the click; the first cell holds a real button for keyboard users (keep that cell's content non-interactive). */
  onRowClick?: (row: Row) => void
  /** The open SlideOver's row: tint + a 3 px brand marker. */
  selectedKey?: string | null
  sort?: SortState
  onSortChange?: (s: SortState) => void
  /** localStorage key; stores hidden columns only, per viewer. */
  columnPrefsKey?: string
  /** Default true; sticks to the page scroller (<main>). Turns itself off while the table scrolls sideways. */
  stickyHeader?: boolean
  /** <Pagination/> or "Muat lebih banyak". */
  footer?: ReactNode
  /** Fixed body-row height in px (mock: 52). Rows no longer grow with their content, so keep cells on one line
   *  (`whitespace-nowrap`, a truncating tag cell). Unset keeps the content-sized rows. */
  rowHeight?: number
}

const SKELETON_ROWS = 5
const MARKER = 'inset 3px 0 0 var(--color-brand)'

function readHidden(key: string | undefined): string[] | null {
  if (!key) return null
  try {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(key)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : null
  } catch {
    return null
  }
}

function writeHidden(key: string | undefined, hidden: readonly string[]): void {
  if (!key) return
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(hidden))
  } catch {
    // Storage blocked or full: the choice just does not persist.
  }
}

/** Runs of adjacent visible columns that share a group (columns without one are their own run). */
export function groupRuns(cols: readonly { id: string; group?: string }[]): { label: string | null; span: number }[] {
  const runs: { label: string | null; span: number }[] = []
  for (const c of cols) {
    const last = runs[runs.length - 1]
    if (c.group && last && last.label === c.group) last.span += 1
    else runs.push({ label: c.group ?? null, span: 1 })
  }
  return runs
}

function stickyOffsets<Row>(cols: readonly Column<Row>[]): Map<string, number> {
  const offsets = new Map<string, number>()
  let left = 0
  for (const c of cols) {
    if (!c.sticky) break
    offsets.set(c.id, left)
    left += typeof c.width === 'number' ? c.width : 0
  }
  return offsets
}

export function DataTable<Row>({
  caption,
  columns,
  rows,
  rowKey,
  loading,
  error,
  onRetry,
  empty,
  onRowClick,
  selectedKey,
  sort,
  onSortChange,
  columnPrefsKey,
  stickyHeader = true,
  footer,
  rowHeight,
}: DataTableProps<Row>) {
  const [hidden, setHidden] = useState<string[]>(
    () => readHidden(columnPrefsKey) ?? columns.filter((c) => c.defaultHidden).map((c) => c.id),
  )
  const [chooser, setChooser] = useState(false)
  const { wrapperRef, tableRef, overflowing } = useHorizontalOverflow()
  // A sticky th sticks to the nearest scroll container; once the wrapper scrolls sideways that is the wrapper, not <main>.
  const stuck = stickyHeader && !overflowing

  const isHideable = (c: Column<Row>) => c.hideable ?? !c.sticky
  const visible = columns.filter((c) => !hidden.includes(c.id) || !isHideable(c))
  const offsets = stickyOffsets(visible)
  const grouped = visible.some((c) => c.group)
  const chooseable = columns.filter(isHideable)

  const toggle = (id: string) => {
    const next = hidden.includes(id) ? hidden.filter((h) => h !== id) : [...hidden, id]
    setHidden(next)
    writeHidden(columnPrefsKey, next)
  }

  const cellStyle = (c: Column<Row>, extra?: CSSProperties): CSSProperties => ({
    width: c.width,
    minWidth: typeof c.width === 'number' ? c.width : undefined,
    left: offsets.get(c.id),
    ...extra,
  })
  const cellClass = (c: Column<Row>) =>
    cn(c.align === 'right' && 'text-right tabular-nums', offsets.has(c.id) && 'sticky z-[1]')

  const th = (c: Column<Row>) => {
    const sorted = c.sortKey !== undefined && sort?.key === c.sortKey ? sort.dir : null
    const sortable = c.sortKey !== undefined && !!onSortChange
    return (
      <th
        key={c.id}
        scope="col"
        aria-sort={sortable ? (sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none') : undefined}
        style={cellStyle(c)}
        className={cn(
          'bg-white px-4 py-3 text-xs font-semibold uppercase tracking-wider text-ink-500',
          c.align === 'right' ? 'text-right' : 'text-left',
          stuck && 'sticky top-0 z-[2]',
          'shadow-[inset_0_-1px_0_var(--color-paper-2)]',
          offsets.has(c.id) && 'z-[3]',
        )}
      >
        {sortable ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-strong"
            onClick={() =>
              onSortChange?.({ key: c.sortKey as string, dir: sorted === 'asc' ? 'desc' : 'asc' })
            }
          >
            {c.header}
            {sorted === 'asc' && <ArrowUp className="h-3 w-3" aria-hidden="true" />}
            {sorted === 'desc' && <ArrowDown className="h-3 w-3" aria-hidden="true" />}
          </button>
        ) : (
          c.header
        )}
      </th>
    )
  }

  return (
    <div className="surface-card overflow-clip rounded-2xl">
      {chooseable.length > 0 && columnPrefsKey && (
        <div className="relative flex justify-end border-b border-paper-2 px-3 py-2">
          <Button
            variant="ghost"
            size="sm"
            icon={<Columns3 className="h-3.5 w-3.5" aria-hidden="true" />}
            aria-expanded={chooser}
            onClick={() => setChooser((v) => !v)}
          >
            Kolom
          </Button>
          {chooser && (
            <fieldset className="absolute right-3 top-full z-10 min-w-44 rounded-xl border border-paper-2 bg-white p-2 shadow-lg">
              <legend className="sr-only">Kolom yang ditampilkan</legend>
              {chooseable.map((c) => (
                <label key={c.id} className="flex items-center gap-2 px-2 py-1.5 text-xs font-bold text-ink-700">
                  <input type="checkbox" checked={!hidden.includes(c.id)} onChange={() => toggle(c.id)} />
                  {c.header}
                </label>
              ))}
            </fieldset>
          )}
        </div>
      )}

      {error && (
        <div role="alert" className="flex items-center justify-between gap-3 bg-danger-bg px-4 py-3 text-sm text-danger">
          <span>{error}</span>
          {onRetry && (
            <Button variant="secondary" size="sm" onClick={onRetry}>
              Coba lagi
            </Button>
          )}
        </div>
      )}

      <div ref={wrapperRef} className={overflowing ? 'overflow-x-auto' : 'overflow-x-clip'}>
        <table ref={tableRef} className="w-full border-collapse text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            {grouped && (
              <tr>
                {groupRuns(visible).map((run, i) => (
                  <th
                    key={`${run.label ?? 'x'}-${i}`}
                    scope="colgroup"
                    colSpan={run.span}
                    className="border-b border-paper-2 bg-white px-4 pt-2 text-left text-[11px] font-black uppercase tracking-wider text-ink-700"
                  >
                    {run.label}
                  </th>
                ))}
              </tr>
            )}
            <tr>{visible.map(th)}</tr>
          </thead>
          <tbody className="divide-y divide-paper-2">
            {loading &&
              Array.from({ length: SKELETON_ROWS }, (_, i) => (
                <tr key={`sk-${i}`} aria-hidden="true">
                  {visible.map((c) => (
                    <td key={c.id} className="px-4 py-3">
                      <div className="h-4 animate-pulse rounded bg-paper-2" />
                    </td>
                  ))}
                </tr>
              ))}
            {!loading && !error && rows.length === 0 && empty && (
              <tr>
                <td colSpan={Math.max(1, visible.length)}>{empty}</td>
              </tr>
            )}
            {!loading &&
              rows.map((row) => {
                const key = rowKey(row)
                const selected = selectedKey === key
                return (
                  <tr
                    key={key}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    style={rowHeight ? { height: rowHeight } : undefined}
                    className={cn(onRowClick && 'cursor-pointer hover:bg-paper-0', selected && 'bg-paper-1')}
                  >
                    {visible.map((c, i) => {
                      const content = c.cell(row)
                      return (
                        <td
                          key={c.id}
                          style={cellStyle(c, i === 0 && selected ? { boxShadow: MARKER } : undefined)}
                          className={cn('bg-white px-4 align-middle text-ink-900', rowHeight ? 'py-0' : 'py-3', cellClass(c))}
                        >
                          {i === 0 && onRowClick ? (
                            <button
                              type="button"
                              aria-current={selected ? 'true' : undefined}
                              className="rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-strong"
                              onClick={(e) => {
                                e.stopPropagation()
                                onRowClick(row)
                              }}
                            >
                              {content}
                            </button>
                          ) : (
                            content
                          )}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
          </tbody>
        </table>
      </div>

      {footer && <div className="border-t border-paper-2 px-4 py-3">{footer}</div>}
    </div>
  )
}
