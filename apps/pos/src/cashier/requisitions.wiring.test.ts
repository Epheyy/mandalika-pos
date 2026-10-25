import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// S6 source-level guards (CashierScreen has no DOM harness): the tablet never reaches the warehouse
// actions of a requisition, the list is always pinned to this outlet, and the screen is wired behind
// canRequestStock, the Back handler, and the auto-pull gate.
const srcRoot = fileURLToPath(new URL('..', import.meta.url))

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return sources(p)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : []
  })
}
const files = sources(srcRoot).map((p) => ({ p, text: readFileSync(p, 'utf8') }))
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

describe('Permintaan Barang wiring (S6)', () => {
  it('no POS source references the warehouse requisition methods', () => {
    expect(files.length).toBeGreaterThan(50)
    for (const f of files) {
      expect(f.text, f.p).not.toMatch(/\b(approveRequisition|rejectRequisition|fulfilRequisition)\b/)
    }
  })

  it('every list call passes outletId (a manager or admin on the tablet must not see other outlets)', () => {
    const calls = files.flatMap((f) => [...f.text.matchAll(/\blistRequisitions\(([^)]*)\)/g)].map((m) => ({ f: f.p, args: m[1] })))
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) expect(c.args, c.f).toContain('outletId')
  })

  it('no POS source enqueues a requisition (online-only, never the outbox)', () => {
    for (const f of files) expect(f.text, f.p).not.toMatch(/enqueue\(\s*'[a-z_]*requisition/i)
  })

  const screen = read('./CashierScreen.tsx')
  it('the menu item is gated by canRequestStock and opens the panel', () => {
    expect(screen).toContain('canRequestStock={canRequestStock(user)}')
    expect(screen).toContain('onRequisitions={() => setShowRequisitions(true)}')
    const drawer = read('./MenuDrawer.tsx')
    expect(drawer).toMatch(/canRequestStock \? \[\{[^\]]*'Permintaan Barang'/)
  })

  it('Android Back closes the panel and the auto-pull gate sees it open', () => {
    expect(screen).toContain('if (showRequisitions) { setShowRequisitions(false); return true }')
    expect(screen).toMatch(/useAutoPullGate\(engine, \{[\s\S]*showRequisitions[\s\S]*\}\)/)
  })

  it('"Buka Terima Transfer" closes the panel and opens the existing receive panel', () => {
    expect(screen).toContain('onOpenReceive={() => { setShowRequisitions(false); setShowReceive(true) }}')
  })

  it('the panel is pinned to the signed-in outlet and the live reachability', () => {
    expect(screen).toContain("outletId={authStore.outletId ?? ''}")
    expect(screen).toContain('isOnline={offlineData.isOnline}')
  })
})
