// Preset tag palette — single source of truth for chip styling. Must match the
// backend's validTagColors tokens (amber/blue/green/red/purple/gray/pink/teal).
export const TAG_COLORS = ['amber', 'blue', 'green', 'red', 'purple', 'gray', 'pink', 'teal'] as const
export type TagColor = (typeof TAG_COLORS)[number]

const CLASSES: Record<TagColor, string> = {
  amber: 'bg-amber-100 text-amber-800 border-amber-200',
  blue: 'bg-blue-100 text-blue-800 border-blue-200',
  green: 'bg-green-100 text-green-800 border-green-200',
  red: 'bg-red-100 text-red-800 border-red-200',
  purple: 'bg-purple-100 text-purple-800 border-purple-200',
  gray: 'bg-gray-100 text-gray-700 border-gray-200',
  pink: 'bg-pink-100 text-pink-800 border-pink-200',
  teal: 'bg-teal-100 text-teal-800 border-teal-200',
}

/** Chip classes for a color token; falls back to gray for unknown tokens. */
export function tagChipClasses(color: string): string {
  return CLASSES[color as TagColor] ?? CLASSES.gray
}
