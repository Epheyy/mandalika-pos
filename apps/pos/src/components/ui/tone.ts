export type Tone = 'neutral' | 'brand' | 'ok' | 'warn' | 'danger' | 'info' | 'promo' | 'reward'

export const TONES: readonly Tone[] = ['neutral', 'brand', 'ok', 'warn', 'danger', 'info', 'promo', 'reward']

// Static lookup: Tailwind only emits classes it can see as whole strings.
const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'bg-paper-1 text-ink-700',
  brand: 'bg-brand text-on-brand',
  ok: 'bg-ok-bg text-ok',
  warn: 'bg-warn-bg text-warn',
  danger: 'bg-danger-bg text-danger',
  info: 'bg-info-bg text-info',
  promo: 'bg-promo-bg text-promo',
  reward: 'bg-reward-bg text-reward',
}

export function toneClasses(tone: Tone): string {
  return TONE_CLASSES[tone]
}
