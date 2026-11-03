import type { Tone } from './types'

/** Tone names understood by ui/Badge today; lets unmigrated screens render the shared label maps. */
export type BadgeToneName = 'gold' | 'success' | 'danger' | 'warning' | 'neutral'

const BADGE_TONE: Record<Tone, BadgeToneName> = {
  ok: 'success',
  warn: 'warning',
  info: 'gold',
  danger: 'danger',
  neutral: 'neutral',
  promo: 'neutral',
  reward: 'neutral',
}

export const badgeTone = (t: Tone): BadgeToneName => BADGE_TONE[t]
