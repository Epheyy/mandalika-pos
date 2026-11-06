export interface RunStats {
  frames: number
  medianFps: number
  p5Fps: number
  over50: number
  worstMs: number
  pass: boolean
}

const PASS_MEDIAN_FPS = 55
const SLOW_FRAME_MS = 50

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[idx]
}

/** Frame deltas in ms -> plain numbers. Median fps = 1000 / median delta; 5th-percentile fps = 1000 / 95th-percentile delta. */
export function computeStats(deltas: number[]): RunStats {
  if (deltas.length === 0) return { frames: 0, medianFps: 0, p5Fps: 0, over50: 0, worstMs: 0, pass: false }
  const sorted = [...deltas].sort((a, b) => a - b)
  const medianFps = 1000 / percentile(sorted, 0.5)
  const p5Fps = 1000 / percentile(sorted, 0.95)
  const over50 = deltas.filter((d) => d > SLOW_FRAME_MS).length
  const worstMs = sorted[sorted.length - 1]
  return { frames: deltas.length, medianFps, p5Fps, over50, worstMs, pass: medianFps >= PASS_MEDIAN_FPS && over50 === 0 }
}
