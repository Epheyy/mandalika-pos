import { useState, useEffect, useReducer } from 'react'
import type { DupCandidate, Customer } from '@mandalika/api'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { api } from '../../api'
import { BRAND } from '../../lib/brand'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { tagChipClasses } from './tagColors'
import {
  computeConflicts, MERGE_FIELD_LABELS,
  type MergeField,
} from './mergeTypes'

interface MergeReviewProps {
  candidateId: string
  onBack: () => void
}

function CustomerSummary({ c, label }: { c: Customer; label: string }) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-black text-gray-400 uppercase tracking-wider">{label}</p>
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-gold-50 flex items-center justify-center flex-shrink-0">
          <span className="text-sm font-black text-gold-600">{c.name.charAt(0).toUpperCase()}</span>
        </div>
        <div>
          <p className="font-black text-gray-900 text-sm">{c.name}</p>
          <p className="text-xs text-gray-400">{c.phone}</p>
        </div>
      </div>
      <div className="space-y-1 text-xs text-gray-600">
        <div><span className="text-gray-400">Email:</span> {c.email || '—'}</div>
        <div><span className="text-gray-400">Poin:</span> {c.points.toLocaleString('id-ID')}</div>
        <div><span className="text-gray-400">Total Belanja:</span> {BRAND.currency.format(c.totalSpent)}</div>
        <div><span className="text-gray-400">Kunjungan:</span> {c.visitCount}</div>
      </div>
      {(c.tags ?? []).length > 0 && (
        <div className="flex flex-wrap gap-1 pt-1">
          {(c.tags ?? []).map((t) => (
            <span key={t.id} className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold border ${tagChipClasses(t.color)}`}>
              {t.name}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// Coordinated review cluster: a new pair resets the keeper side, choices are
// recomputed when the pair/keeper side changes, the user flips choices, then
// opens the confirm. Grouped into one reducer to keep these moves coordinated.
interface MergeState {
  pair: DupCandidate | null
  keeperIsExisting: boolean
  choices: Record<string, 'keeper' | 'dup'>
  confirmOpen: boolean
}

type MergeAction =
  | { type: 'SET_PAIR'; pair: DupCandidate | null }
  | { type: 'SET_KEEPER'; keeperIsExisting: boolean }
  | { type: 'SET_CHOICES'; choices: Record<string, 'keeper' | 'dup'> }
  | { type: 'SET_FIELD_CHOICE'; field: string; side: 'keeper' | 'dup' }
  | { type: 'OPEN_CONFIRM' }
  | { type: 'CLOSE_CONFIRM' }

const initialMergeState: MergeState = {
  pair: null,
  keeperIsExisting: true,
  choices: {},
  confirmOpen: false,
}

function mergeReducer(state: MergeState, action: MergeAction): MergeState {
  switch (action.type) {
    case 'SET_PAIR':
      return { ...state, pair: action.pair }
    case 'SET_KEEPER':
      return { ...state, keeperIsExisting: action.keeperIsExisting }
    case 'SET_CHOICES':
      return { ...state, choices: action.choices }
    case 'SET_FIELD_CHOICE':
      return { ...state, choices: { ...state.choices, [action.field]: action.side } }
    case 'OPEN_CONFIRM':
      return { ...state, confirmOpen: true }
    case 'CLOSE_CONFIRM':
      return { ...state, confirmOpen: false }
    default:
      return state
  }
}

export default function MergeReview({ candidateId, onBack }: MergeReviewProps) {
  const [review, dispatch] = useReducer(mergeReducer, initialMergeState)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionErr, setActionErr] = useState<string | null>(null)

  useEffect(() => {
    let ignore = false
    setLoading(true)
    setErr(null)
    api.getDupCandidate(candidateId)
      .then((d) => { if (!ignore) { dispatch({ type: 'SET_PAIR', pair: d }); dispatch({ type: 'SET_KEEPER', keeperIsExisting: true }) } })
      .catch((e: unknown) => { if (!ignore) setErr(e instanceof Error ? e.message : 'Gagal memuat data duplikat') })
      .finally(() => { if (!ignore) setLoading(false) })
    return () => { ignore = true }
  }, [candidateId])

  // Recompute choices whenever pair or keeperIsExisting changes
  useEffect(() => {
    if (!review.pair) return
    const keeper = review.keeperIsExisting ? review.pair.existingCustomer : review.pair.newCustomer
    const dup = review.keeperIsExisting ? review.pair.newCustomer : review.pair.existingCustomer
    const conflicts = computeConflicts(keeper, dup)
    const seed: Record<string, 'keeper' | 'dup'> = {}
    for (const c of conflicts) seed[c.field] = c.default
    dispatch({ type: 'SET_CHOICES', choices: seed })
  }, [review.pair, review.keeperIsExisting])

  if (loading) {
    return (
      <div className="p-6">
        <button type="button" onClick={onBack} className="flex items-center gap-2 text-sm font-bold text-gray-500 hover:text-gray-900 mb-4">
          <ArrowLeft className="w-4 h-4" /> Kembali
        </button>
        <p className="text-sm text-gray-400">Memuat data…</p>
      </div>
    )
  }
  if (err || !review.pair) {
    return (
      <div className="p-6">
        <button type="button" onClick={onBack} className="flex items-center gap-2 text-sm font-bold text-gray-500 hover:text-gray-900 mb-4">
          <ArrowLeft className="w-4 h-4" /> Kembali
        </button>
        <p className="text-sm text-red-600">{err ?? 'Data tidak ditemukan'}</p>
      </div>
    )
  }

  const pair = review.pair
  const keeperIsExisting = review.keeperIsExisting
  const choices = review.choices
  const keeper = keeperIsExisting ? pair.existingCustomer : pair.newCustomer
  const dup = keeperIsExisting ? pair.newCustomer : pair.existingCustomer
  const conflicts = computeConflicts(keeper, dup)

  // Tags union (dedupe by id)
  const allTagIds = new Set<string>()
  const unionTags: { id: string; name: string; color: string }[] = []
  for (const t of [...(pair.existingCustomer.tags ?? []), ...(pair.newCustomer.tags ?? [])]) {
    if (!allTagIds.has(t.id)) { allTagIds.add(t.id); unionTags.push(t) }
  }

  const doMerge = async () => {
    setBusy(true)
    setActionErr(null)
    try {
      await api.mergeDupCandidate(candidateId, { keeperId: keeper.id, fieldChoices: choices })
      onBack()
    } catch (e: unknown) {
      setActionErr(e instanceof Error ? e.message : 'Gagal menggabungkan pelanggan')
    } finally {
      setBusy(false)
    }
  }

  const doDismiss = async () => {
    setBusy(true)
    setActionErr(null)
    try {
      await api.dismissDupCandidate(candidateId)
      onBack()
    } catch (e: unknown) {
      setActionErr(e instanceof Error ? e.message : 'Gagal melewati duplikat')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="p-6 space-y-5">
      <button type="button" onClick={onBack} className="flex items-center gap-2 text-sm font-bold text-gray-500 hover:text-gray-900">
        <ArrowLeft className="w-4 h-4" /> Kembali ke Daftar Duplikat
      </button>

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-black text-gray-900">Tinjau Duplikat</h2>
          <p className="text-sm text-gray-400">Telepon: {pair.phone}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="secondary" disabled={busy} onClick={doDismiss} loading={busy}>
            Bukan Duplikat
          </Button>
          <Button disabled={busy} onClick={() => dispatch({ type: 'OPEN_CONFIRM' })}>
            Gabungkan
          </Button>
        </div>
      </div>

      {actionErr && <p className="text-sm text-red-600">{actionErr}</p>}

      {/* Keeper selector */}
      <Card className="p-5 space-y-3">
        <p className="text-xs font-black text-gray-400 uppercase tracking-wider">Pilih Pelanggan Utama (Keeper)</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {([true, false] as const).map((isExisting) => {
            const c = isExisting ? pair.existingCustomer : pair.newCustomer
            const isSelected = keeperIsExisting === isExisting
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => dispatch({ type: 'SET_KEEPER', keeperIsExisting: isExisting })}
                className={`text-left p-4 rounded-xl border-2 transition-all ${isSelected ? 'border-gold-500 bg-gold-50' : 'border-gray-200 hover:border-gray-300'}`}
              >
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-xs font-bold text-gray-500">{isExisting ? 'Pelanggan Lama' : 'Pelanggan Baru'}</span>
                  {isSelected && <span className="text-xs font-black text-gold-700 bg-gold-100 px-2 py-0.5 rounded-full">KEEPER</span>}
                </div>
                <p className="font-black text-gray-900 text-sm">{c.name}</p>
                <p className="text-xs text-gray-400">{c.phone}</p>
              </button>
            )
          })}
        </div>
        <p className="text-xs text-gray-400">
          Keeper = data yang dipertahankan. Pesanan & poin dari kedua pelanggan akan digabungkan ke keeper.
        </p>
      </Card>

      {/* Side-by-side summary */}
      <Card className="p-5">
        <p className="text-xs font-black text-gray-400 uppercase tracking-wider mb-4">Ringkasan</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          <CustomerSummary c={keeper} label={`Keeper — ${keeperIsExisting ? 'Lama' : 'Baru'}`} />
          <div className="relative sm:block hidden">
            <div className="absolute left-0 top-0 bottom-0 w-px bg-gray-100" />
          </div>
          <CustomerSummary c={dup} label={`Duplikat — ${keeperIsExisting ? 'Baru' : 'Lama'}`} />
        </div>
      </Card>

      {/* Conflicts panel */}
      {conflicts.length > 0 && (
        <Card className="overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100">
            <p className="font-black text-gray-900 text-sm">Pilih Nilai Field yang Berbeda</p>
            <p className="text-xs text-gray-400">Untuk field yang tidak ditampilkan di sini, nilai keeper digunakan otomatis.</p>
          </div>
          <div className="divide-y divide-gray-50">
            {conflicts.map((conflict) => (
              <div key={conflict.field} className="px-5 py-4">
                <p className="text-xs font-black text-gray-500 uppercase tracking-wider mb-2">
                  {MERGE_FIELD_LABELS[conflict.field as MergeField]}
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <label className={`flex items-start gap-2 p-3 rounded-xl border-2 cursor-pointer transition-all ${choices[conflict.field] === 'keeper' ? 'border-gold-500 bg-gold-50' : 'border-gray-200 hover:border-gray-300'}`}>
                    <input
                      type="radio"
                      name={`field-${conflict.field}`}
                      checked={choices[conflict.field] === 'keeper'}
                      onChange={() => dispatch({ type: 'SET_FIELD_CHOICE', field: conflict.field, side: 'keeper' })}
                      className="mt-0.5 accent-gold-600 flex-shrink-0"
                    />
                    <div>
                      <p className="text-[10px] font-bold text-gray-400 uppercase">Keeper ({keeperIsExisting ? 'Lama' : 'Baru'})</p>
                      <p className="text-sm text-gray-700 break-words">{conflict.keeper ?? '—'}</p>
                    </div>
                  </label>
                  <label className={`flex items-start gap-2 p-3 rounded-xl border-2 cursor-pointer transition-all ${choices[conflict.field] === 'dup' ? 'border-gold-500 bg-gold-50' : 'border-gray-200 hover:border-gray-300'}`}>
                    <input
                      type="radio"
                      name={`field-${conflict.field}`}
                      checked={choices[conflict.field] === 'dup'}
                      onChange={() => dispatch({ type: 'SET_FIELD_CHOICE', field: conflict.field, side: 'dup' })}
                      className="mt-0.5 accent-gold-600 flex-shrink-0"
                    />
                    <div>
                      <p className="text-[10px] font-bold text-gray-400 uppercase">Duplikat ({keeperIsExisting ? 'Baru' : 'Lama'})</p>
                      <p className="text-sm text-gray-700 break-words">{conflict.dup ?? '—'}</p>
                    </div>
                  </label>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Tags union preview */}
      {unionTags.length > 0 && (
        <Card className="p-5">
          <p className="text-xs font-black text-gray-400 uppercase tracking-wider mb-3">
            Tag Gabungan (Preview)
          </p>
          <div className="flex flex-wrap gap-1.5">
            {unionTags.map((t) => (
              <span key={t.id} className={`px-2.5 py-1 rounded-full text-xs font-bold border ${tagChipClasses(t.color)}`}>
                {t.name}
              </span>
            ))}
          </div>
        </Card>
      )}

      {/* Confirm modal (inline, no Modal component to keep it simple) */}
      {review.confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <Card className="p-6 space-y-4 max-w-sm w-full shadow-2xl">
            <div className="text-center">
              <div className="w-14 h-14 bg-amber-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <ArrowRight className="w-7 h-7 text-amber-600" />
              </div>
              <h3 className="text-lg font-black text-gray-900 mb-2">Gabungkan Pelanggan?</h3>
              <p className="text-sm text-gray-500">
                Gabungkan <span className="font-bold text-gray-900">{dup.name}</span> ke{' '}
                <span className="font-bold text-gray-900">{keeper.name}</span> secara permanen?
                Pesanan &amp; poin pindah; tidak bisa dibatalkan otomatis.
              </p>
            </div>
            {actionErr && <p className="text-sm text-red-600 text-center">{actionErr}</p>}
            <div className="flex gap-3">
              <Button variant="secondary" className="flex-1" disabled={busy} onClick={() => dispatch({ type: 'CLOSE_CONFIRM' })}>
                Batal
              </Button>
              <Button variant="danger" className="flex-1" loading={busy} onClick={doMerge}>
                Ya, Gabungkan
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}
