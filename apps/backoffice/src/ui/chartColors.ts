/** Gold-forward data-viz palette — replaces the indigo-blue chart colors so
 *  charts read as part of the brand instead of a stock template. */
export const CHART_SERIES = [
  '#b07d18', // gold 600 (primary)
  '#d4a030', // gold 400
  '#8f6210', // gold 700
  '#e4b84a', // gold 300
  '#c49020', // gold 500
  '#f0d48a', // gold 200
  '#6e4a0c', // gold 800
  '#f9edcc', // gold 100
] as const

export const CHART_PRIMARY = '#b07d18'
export const CHART_GRID = '#e8e2d7' // warm gray-200
export const CHART_AXIS = '#a89f8f' // warm gray-400

/** Shared recharts tooltip styling (warm shadow, rounded). */
export const CHART_TOOLTIP = {
  borderRadius: 12,
  border: 'none',
  boxShadow: '0 4px 20px rgba(26,16,8,0.12)',
} as const
