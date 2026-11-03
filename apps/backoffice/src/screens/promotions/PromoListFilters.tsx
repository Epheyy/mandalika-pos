import { DISCOUNT_CODE_TYPE, PROMOTION_STATUS, PROMOTION_TYPE } from '../../lib/labels'
import { FilterBar } from '../../ui/FilterBar'
import { PROMO_STATUS_CODES } from './promoStatus'
import type { PromoListKind, PromoListState } from './promoListState'

interface PromoListFiltersProps {
  kind: PromoListKind
  state: PromoListState
  activeCount: number
  onChange: (patch: Partial<PromoListState>) => void
  onReset: () => void
}

const STATUS_ITEMS = [{ id: '', label: 'Semua' }, ...PROMO_STATUS_CODES.map((id) => ({ id, label: PROMOTION_STATUS[id].label }))]

/** Search, status chips and jenis for either list. Status already carries the date window (terjadwal / berakhir). */
export function PromoListFilters({ kind, state, activeCount, onChange, onReset }: PromoListFiltersProps) {
  const typeMap: Record<string, { label: string }> = kind === 'promotions' ? PROMOTION_TYPE : DISCOUNT_CODE_TYPE
  const jenisOptions = [{ value: '', label: 'Semua jenis' }, ...Object.entries(typeMap).map(([value, e]) => ({ value, label: e.label }))]
  return (
    <FilterBar onReset={onReset} activeCount={activeCount}>
      <FilterBar.Search
        label={kind === 'promotions' ? 'Cari promosi' : 'Cari kode diskon'}
        placeholder={kind === 'promotions' ? 'Nama atau deskripsi' : 'Kode atau nama pelanggan'}
        value={state.q}
        onChange={(q) => onChange({ q })}
      />
      <FilterBar.Select label="Jenis" value={state.jenis} onChange={(jenis) => onChange({ jenis })} options={jenisOptions} />
      <FilterBar.Chips label="Status" items={STATUS_ITEMS} value={state.status} onChange={(status) => onChange({ status })} />
    </FilterBar>
  )
}
