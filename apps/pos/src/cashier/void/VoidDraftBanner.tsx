import { Banner } from '../../components/ui/Banner'
import { Chip } from '../../components/ui/Chip'
import { isLocked, type VoidDraft } from './voidReplacement'

export const VOID_CHOICE_ADJUST = 'Catat sebagai Penyesuaian koreksi'
export const VOID_CHOICE_SETTLE = 'Pelanggan bayar/terima selisih'

interface VoidDraftBannerProps {
  draft: VoidDraft
  choice: 'adjust' | 'settle'
  onChoice: (choice: 'adjust' | 'settle') => void
  /** Drops the replacement cart; nothing was voided. */
  onCancel: () => void
}

/** Persistent while a replacement cart is open: says the original is not voided yet, offers `Batalkan pengganti`, and (only
 *  when the server lets the amount differ) the choice of how the gap to the original total is settled. */
export function VoidDraftBanner({ draft, choice, onChoice, onCancel }: VoidDraftBannerProps) {
  const wording = draft.kind === 'create_replacement' ? `Pengganti untuk transaksi #${draft.orderNumber}` : `Pembatalan transaksi #${draft.orderNumber} menunggu pengganti`
  return (
    <div data-testid="void-draft-banner" className="flex-shrink-0">
      <Banner tone="warn" message={wording} action={{ label: 'Batalkan pengganti', onClick: onCancel }} />
      {!isLocked(draft) && (
        <div role="group" aria-label="Selisih dengan transaksi asli" className="flex flex-wrap gap-2 px-4 py-2 bg-warn-bg">
          <Chip selected={choice === 'adjust'} onClick={() => onChoice('adjust')}>{VOID_CHOICE_ADJUST}</Chip>
          <Chip selected={choice === 'settle'} onClick={() => onChoice('settle')}>{VOID_CHOICE_SETTLE}</Chip>
        </div>
      )}
    </div>
  )
}
