import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { computeStats, type RunStats } from './frameStats'

export type Material = 'glass' | 'static' | 'solid'
type Mode = 'auto' | 'manual'

const RUN_MS = 10_000
const AUTO_STEP_PX = 12 // pixels per frame while the auto run scrolls down and back
const MANUAL_ACTIVE_MS = 120 // a manual frame only counts while the grid moved in the last 120 ms
const MIN_MANUAL_FRAMES = 60

export const MATERIAL_LABEL: Record<Material, string> = { glass: 'kaca', static: 'statis', solid: 'solid' }
const MODE_LABEL: Record<Mode, string> = { auto: 'otomatis', manual: 'manual' }

interface ResultRow extends RunStats {
  id: number
  material: Material
  mode: Mode
  ambient: boolean
}

interface ActiveRun {
  mode: Mode
  start: number
  last: number | null
  deltas: number[]
  pos: number
  dir: 1 | -1
  max: number
  material: Material
  ambient: boolean
}

const chromeVersion = /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? 'tidak diketahui'

function fmt(n: number): string {
  return n.toFixed(1)
}

function rowText(r: ResultRow): string {
  const verdict = r.frames < MIN_MANUAL_FRAMES ? 'ULANG (terlalu sedikit gulir)' : r.pass ? 'PASS' : 'FAIL'
  return `#${r.id} Bahan: ${MATERIAL_LABEL[r.material]} | Uji ${MODE_LABEL[r.mode]} | Latar: ${r.ambient ? 'nyala' : 'mati'} | median ${fmt(r.medianFps)} fps | P5 ${fmt(r.p5Fps)} fps | frame >50ms: ${r.over50} | terburuk ${fmt(r.worstMs)} ms | ${r.frames} frame | ${verdict}`
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  }
}

interface Props {
  scrollerRef: RefObject<HTMLDivElement | null>
  material: Material
  ambient: boolean
}

/** Solid measurement panel. Lives in the cart column, never over the scroller. */
export function MeasurePanel({ scrollerRef, material, ambient }: Props) {
  const [fps, setFps] = useState(0)
  const [running, setRunning] = useState<Mode | null>(null)
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [rows, setRows] = useState<ResultRow[]>([])
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null)
  const runRef = useRef<ActiveRun | null>(null)
  const lastScrollTs = useRef(0)
  const nextId = useRef(1)
  const materialRef = useRef(material)
  const ambientRef = useRef(ambient)
  materialRef.current = material
  ambientRef.current = ambient

  // One rAF loop for the live readout and for any active run.
  useEffect(() => {
    let raf = 0
    let prev: number | null = null
    let acc = 0
    let accFrames = 0
    let lastHud = 0
    const tick = (now: number) => {
      const delta = prev === null ? null : now - prev
      prev = now
      if (delta !== null) {
        acc += delta
        accFrames += 1
        if (now - lastHud >= 500) {
          setFps(accFrames * 1000 / acc)
          acc = 0
          accFrames = 0
          lastHud = now
        }
      }
      const run = runRef.current
      if (run) {
        if (run.mode === 'auto') {
          const el = scrollerRef.current
          if (el) {
            let next = run.pos + run.dir * AUTO_STEP_PX
            if (next >= run.max) {
              next = run.max
              run.dir = -1
            } else if (next <= 0) {
              next = 0
              run.dir = 1
            }
            run.pos = next
            el.scrollTop = next
          }
        }
        const counts = run.mode === 'auto' || now - lastScrollTs.current < MANUAL_ACTIVE_MS
        if (run.last !== null && delta !== null && counts) run.deltas.push(delta)
        run.last = now
        const elapsed = now - run.start
        setSecondsLeft(Math.max(0, Math.ceil((RUN_MS - elapsed) / 1000)))
        if (elapsed >= RUN_MS) {
          runRef.current = null
          const stats = computeStats(run.deltas)
          setRows((rs) => [...rs, { ...stats, id: nextId.current++, material: run.material, mode: run.mode, ambient: run.ambient }])
          setRunning(null)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [scrollerRef])

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const onScroll = () => {
      lastScrollTs.current = performance.now()
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [scrollerRef])

  const start = useCallback(
    (mode: Mode) => {
      const el = scrollerRef.current
      if (!el || runRef.current) return
      const max = Math.max(0, el.scrollHeight - el.clientHeight)
      runRef.current = {
        mode,
        start: performance.now(),
        last: null,
        deltas: [],
        pos: el.scrollTop,
        dir: 1,
        max,
        material: materialRef.current,
        ambient: ambientRef.current,
      }
      setSecondsLeft(RUN_MS / 1000)
      setRunning(mode)
    },
    [scrollerRef],
  )

  const copyAll = async () => {
    const header = `POS Probe A9 | DPR ${window.devicePixelRatio} | layar ${window.innerWidth}x${window.innerHeight} | Chrome ${chromeVersion}`
    const ok = await copyText([header, ...rows.map(rowText)].join('\n'))
    setCopied(ok ? 'ok' : 'fail')
    window.setTimeout(() => setCopied(null), 2500)
  }

  const btn =
    'press min-h-11 flex-1 rounded-control border border-paper-2 bg-white px-2 text-sm font-semibold text-ink-900 disabled:opacity-40'
  const last = rows[rows.length - 1]

  return (
    <section aria-label="Panel pengukuran" className="surface-solid m-3 flex max-h-[58%] flex-shrink-0 flex-col gap-2 overflow-hidden rounded-panel p-3">
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-bold text-ink-900">Pengukuran</p>
        <p className="tnum text-2xl font-bold text-ink-900">
          {fps.toFixed(0)} <span className="text-sm font-semibold text-ink-500">fps</span>
        </p>
      </div>
      <p className="text-xs text-ink-700">
        Bahan: <b>{MATERIAL_LABEL[material]}</b> · Latar: <b>{ambient ? 'nyala' : 'mati'}</b>
      </p>
      <div className="flex gap-2">
        <button type="button" className={btn} disabled={running !== null} onClick={() => start('auto')}>
          Uji otomatis 10 dtk
        </button>
        <button type="button" className={btn} disabled={running !== null} onClick={() => start('manual')}>
          Uji manual 10 dtk
        </button>
      </div>
      {running && (
        <p role="status" className="rounded-control bg-paper-1 px-3 py-2 text-sm font-semibold text-ink-900">
          {running === 'auto' ? 'Menggulir otomatis…' : 'Gulir sendiri dengan jari (fling) sekarang…'} {secondsLeft} dtk
        </p>
      )}
      {!running && last && (
        <p className={`rounded-control px-3 py-2 text-sm font-bold ${last.frames < MIN_MANUAL_FRAMES ? 'bg-paper-1 text-ink-900' : last.pass ? 'bg-ok/20 text-ink-900' : 'bg-danger/15 text-ink-900'}`}>
          {last.frames < MIN_MANUAL_FRAMES ? 'ULANG: terlalu sedikit gulir' : last.pass ? 'PASS' : 'FAIL'} · median {fmt(last.medianFps)} fps · 5% terendah {fmt(last.p5Fps)} fps · frame &gt;50 ms: {last.over50} · terburuk {fmt(last.worstMs)} ms
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto rounded-control border border-paper-2 bg-white">
        <table className="tnum w-full text-left text-[0.6875rem] leading-tight text-ink-900">
          <thead className="sticky top-0 bg-paper-1 text-ink-700">
            <tr>
              <th className="px-1.5 py-1">Bahan</th>
              <th className="px-1">Uji</th>
              <th className="px-1">Latar</th>
              <th className="px-1">Med</th>
              <th className="px-1">P5</th>
              <th className="px-1">&gt;50</th>
              <th className="px-1">Max</th>
              <th className="px-1">Hasil</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-1.5 py-2 text-ink-500">
                  Belum ada hasil.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-paper-2">
                <td className="px-1.5 py-1">{MATERIAL_LABEL[r.material]}</td>
                <td className="px-1">{r.mode === 'auto' ? 'oto' : 'man'}</td>
                <td className="px-1">{r.ambient ? 'nyala' : 'mati'}</td>
                <td className="px-1">{fmt(r.medianFps)}</td>
                <td className="px-1">{fmt(r.p5Fps)}</td>
                <td className="px-1">{r.over50}</td>
                <td className="px-1">{fmt(r.worstMs)}</td>
                <td className="px-1 font-bold">{r.frames < MIN_MANUAL_FRAMES ? 'ULANG' : r.pass ? 'PASS' : 'FAIL'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className={btn} disabled={rows.length === 0} onClick={() => void copyAll()}>
          Salin hasil
        </button>
        {copied && <span className="text-xs font-semibold text-ink-700">{copied === 'ok' ? 'Tersalin' : 'Gagal menyalin'}</span>}
      </div>
      <p className="text-[0.6875rem] leading-tight text-ink-500">
        DPR {window.devicePixelRatio} · layar {window.innerWidth}×{window.innerHeight} · Chrome {chromeVersion}
      </p>
    </section>
  )
}
