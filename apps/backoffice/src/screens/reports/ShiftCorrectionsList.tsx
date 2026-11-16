import type { components } from '@mandalika/api'
import { BRAND } from '../../lib/brand'
import { Link } from '../../lib/router/Link'
import { buildHash } from '../../lib/router/hash'
import { routeById } from '../../lib/router/routes'

type ShiftCorrections = components['schemas']['ShiftCorrections']

const KIND_LABEL: Record<'void' | 'replacement', string> = { void: 'Batal', replacement: 'Pengganti' }

const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${BRAND.currency.format(Math.abs(n))}`

/** The voids that corrected a closed shift, one row per order and payment method. Expands under the shift row. */
export function ShiftCorrectionsList({ corrections }: { corrections: ShiftCorrections }) {
  return (
    <details className="mt-1 text-xs font-normal">
      <summary className="cursor-pointer text-ink-700">{corrections.count} koreksi</summary>
      <ul className="mt-1 space-y-0.5">
        {corrections.items.map((it) => (
          <li key={`${it.voidId}-${it.kind}-${it.method}`} className="flex flex-wrap gap-x-2">
            <Link to={buildHash([routeById('reports')?.path ?? 'laporan', 'transaksi'], { q: it.orderNumber })} className="font-mono font-bold underline">
              {it.orderNumber}
            </Link>
            <span>{KIND_LABEL[it.kind]}</span>
            <span>{it.method}</span>
            <span className={it.amount < 0 ? 'text-danger' : 'text-ok'}>{signed(it.amount)}</span>
          </li>
        ))}
      </ul>
    </details>
  )
}
