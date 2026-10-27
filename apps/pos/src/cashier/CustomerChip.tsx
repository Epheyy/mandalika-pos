import type { components } from '@mandalika/api'
import { IconUser } from '../components/ui/icons'
import { knownTier, rewardChipText, type ChipState } from './customerProfile'

type Customer = components['schemas']['Customer']

interface CustomerChipProps {
  customer: Customer | null
  loyaltyEnabled: boolean
  rewards: ChipState['rewards']
  /** Opens the Profil Pelanggan sheet (null when the brand has no profile feature: the name is plain text). */
  onOpenProfile: (() => void) | null
  /** Opens the Pelanggan sheet (empty state "+ Pelanggan", and "Ganti"). */
  onOpenPicker: () => void
  /** Releases the customer ("Lepas"); the screen asks first when promos or rewards would drop. */
  onRelease: () => void
}

/** A2/B3 customer chip: "+ Pelanggan" when empty; otherwise name · tier · points and the reward count, with
 *  Ganti and Lepas. Tapping the name opens the profile. */
export function CustomerChip({ customer, loyaltyEnabled, rewards, onOpenProfile, onOpenPicker, onRelease }: CustomerChipProps) {
  if (!customer) {
    return (
      <button
        type="button" onClick={onOpenPicker}
        className="touch flex min-h-14 w-full flex-shrink-0 items-center gap-3 border-b border-paper-2 bg-white px-4 text-left text-[0.9375rem] font-semibold text-ink-900 active:bg-paper-1"
      >
        <IconUser size={20} className="text-ink-500" />
        + Pelanggan
      </button>
    )
  }
  const tier = knownTier(customer)
  const rewardText = loyaltyEnabled ? rewardChipText(rewards) : null
  const body = (
    <>
      <span className="block truncate text-[0.9375rem] font-semibold text-ink-900">{customer.name}</span>
      <span className="block truncate text-[0.8125rem] text-ink-500">
        {customer.phone}
        {tier && ` · ${tier}`}
        {loyaltyEnabled && ` · ${customer.points} poin`}
      </span>
    </>
  )
  return (
    <div className="flex min-h-14 flex-shrink-0 items-center gap-2 bg-paper-1 px-4 py-2">
      <span aria-hidden="true" className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-paper-2 text-base font-bold text-ink-700">
        {(customer.name || '?').charAt(0).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        {onOpenProfile ? (
          <button type="button" onClick={onOpenProfile} aria-label={`Profil ${customer.name}`} className="block w-full min-w-0 text-left">{body}</button>
        ) : (
          <div>{body}</div>
        )}
        {rewardText && <p className={`truncate text-[0.8125rem] font-semibold ${rewards.kind === 'count' && rewards.n > 0 ? 'text-reward' : 'text-ink-500'}`}>{rewardText}</p>}
      </div>
      <button type="button" onClick={onOpenPicker} className="touch flex-shrink-0 rounded-control px-2 text-[0.9375rem] font-semibold text-ink-700 active:bg-paper-2">Ganti</button>
      <button type="button" onClick={onRelease} className="touch flex-shrink-0 rounded-control px-2 text-[0.9375rem] font-semibold text-danger active:bg-paper-2">Lepas</button>
    </div>
  )
}
