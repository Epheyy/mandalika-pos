import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The Rekapan panel has two ways in (ShiftBar "Tutup shift" = close intent, menu "Rekapan" = just look) and two ways
// out (its own close button, Android Back). `closeIntent` used to be cleared only by the close button, so backing out
// of a close left it set: the next plain visit showed the close-shift block, and since `closeIntent` is one of the
// auto-pull gate flags (autoPullGate.ts, every flag must be false) background refresh stayed blocked until the × was
// used or the app restarted. Every way in now states its intent and every way out goes through one function that
// clears both flags.
const src = readFileSync(new URL('./CashierScreen.tsx', import.meta.url), 'utf8')

describe('Rekapan open/close keeps showRecap and closeIntent together', () => {
  it('one close function clears both flags', () => {
    expect(src).toContain('const closeRecap = () => { setShowRecap(false); setCloseIntent(false) }')
  })

  it('one open function sets the intent with the panel', () => {
    expect(src).toContain('const openRecap = (intent: boolean) => { setCloseIntent(intent); setShowRecap(true) }')
  })

  it('Android Back closes the recap through closeRecap', () => {
    expect(src).toContain('if (showRecap) { if (!recapBackRef.current?.()) closeRecap(); return true }')
  })

  it('the panel close button closes through closeRecap', () => {
    expect(src).toContain('onClose={closeRecap}')
  })

  it('ShiftBar opens with the close intent, the menu without it', () => {
    expect(src).toContain('onRequestClose={() => openRecap(true)}')
    expect(src).toContain('onRecap={() => openRecap(false)}')
  })

  it('nothing else flips the flags directly', () => {
    expect(src.match(/setShowRecap\(/g)).toHaveLength(2)
    expect(src.match(/setCloseIntent\(/g)).toHaveLength(2)
  })
})
