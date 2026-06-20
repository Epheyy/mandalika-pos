// POS-local segment palette → chip classes. Mirrors the backoffice tagColors
// tokens (the backend validates exactly these 8). The apps don't share a UI lib.
const SEGMENT_COLORS = ['amber', 'blue', 'green', 'red', 'purple', 'gray', 'pink', 'teal'] as const
export type SegmentColor = (typeof SEGMENT_COLORS)[number]

const CLASSES: Record<SegmentColor, string> = {
  amber: 'bg-amber-100 text-amber-800',
  blue: 'bg-blue-100 text-blue-800',
  green: 'bg-green-100 text-green-800',
  red: 'bg-red-100 text-red-800',
  purple: 'bg-purple-100 text-purple-800',
  gray: 'bg-gray-100 text-gray-700',
  pink: 'bg-pink-100 text-pink-800',
  teal: 'bg-teal-100 text-teal-800',
}

/** Chip classes for a segment color token; falls back to gray. */
export function segmentChipClasses(color: string): string {
  return CLASSES[color as SegmentColor] ?? CLASSES.gray
}
