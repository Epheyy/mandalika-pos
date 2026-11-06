/** Categorical data-viz palette for slices that need telling apart (payment methods). Brand gold leads, then
 *  hues that differ in hue and lightness so neighbouring slices stay distinguishable, and none of them is a
 *  status colour read as good/bad (no red, no green-for-ok pair next to red). Every slice is also named in a
 *  legend beside the chart, so colour is never the only cue. Hex, not var(): recharts needs concrete values. */
export const CHART_SERIES = [
  '#b07d18', // brand gold
  '#2f5fb3', // blue
  '#0f766e', // teal
  '#7c3aed', // violet
  '#7a6f62', // ink-500 (neutral)
  '#c2410c', // rust
  '#4d7c0f', // olive
  '#a21caf', // magenta
] as const

export const CHART_PRIMARY = '#b07d18'
export const CHART_GRID = '#e9e3d8' // paper-2
export const CHART_AXIS = '#7a6f62' // ink-500 (4.9:1 on white)

/** Shared recharts tooltip styling: the Kaca solid panel (opaque, hairline border, warm shadow). */
export const CHART_TOOLTIP = {
  borderRadius: 12,
  border: '1px solid #e9e3d8',
  backgroundColor: '#fffdf9',
  boxShadow: '0 14px 36px -14px rgba(70,46,10,0.28)',
} as const
