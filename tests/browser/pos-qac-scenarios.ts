// QA wave C (2026-11-08): with the cart open the header's right group sits over the cart column (U6), the category
// thumb stays under its tab after the cart opens/closes (U1), and in portrait the last product row clears the
// bottom bar (F25). Shots (A34C_RUN_DIR only) feed the side-by-side with the Kaca mock; no baselines.
import type { ScenarioPage } from './fixture'
import { SHOT_VIEWPORTS, captureShot, type ShotViewport } from './shots'

const assert = (v: unknown, m: string) => { if (!v) throw Error(m) }
const settle = (page: ScenarioPage) => page.evaluate(async () => {
  await document.fonts.ready
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  await new Promise<void>((r) => setTimeout(r, 450))
})
const shot = async (page: ScenarioPage, name: string, vp: ShotViewport) => {
  if (process.env.A34C_RUN_DIR) await captureShot(page as any, name, [vp])
}
const thumbGap = (page: ScenarioPage) => page.evaluate(() => {
  const tab = document.querySelector('[role=tablist] [role=tab][aria-selected=true]') as HTMLElement
  const thumb = document.querySelector('[role=tablist] > span[aria-hidden=true]') as HTMLElement
  const t = tab.getBoundingClientRect(), s = thumb.getBoundingClientRect()
  return { dx: Math.abs(t.left - s.left), dw: Math.abs(t.width - s.width) }
})

export const posQaCHeaderTabs = async (page: ScenarioPage) => {
  const out: Record<string, unknown> = {}
  for (const vp of ['pos-a9', 'pos-a9-portrait'] as ShotViewport[]) {
    await page.setViewportSize(SHOT_VIEWPORTS[vp])
    await settle(page)
    await shot(page, `qac-${vp}-cart-closed`, vp)
    const before = await thumbGap(page)
    assert(before.dx < 1 && before.dw < 1, `${vp}: thumb under its tab with the cart closed (${JSON.stringify(before)})`)
    await page.getByRole('button', { name: /^Filler 01(?!\d)/ }).first().click()
    // Portrait (< sm) keeps the cart on its own tab: the bottom bar appears instead of the cart column.
    if (vp === 'pos-a9') await page.getByRole('button', { name: /^Ubah Filler 01(?!\d)/ }).waitFor()
    else await page.getByRole('button', { name: /^Keranjang/ }).waitFor()
    await settle(page)
    const opened = await thumbGap(page)
    assert(opened.dx < 1 && opened.dw < 1, `${vp}: thumb still under its tab after the cart opened (${JSON.stringify(opened)})`)
    await shot(page, `qac-${vp}-cart-open`, vp)
    const geo = await page.evaluate(() => {
      const shiftBtn = [...document.querySelectorAll('header button')].find((b) => /^Shift/.test(b.textContent?.trim() ?? '')) as HTMLElement
      const cart = [...document.querySelectorAll('[data-kaca-scroller]')][0]?.closest('div.min-w-0')?.nextElementSibling as HTMLElement | null
      const scroller = document.querySelector('[data-kaca-scroller]') as HTMLElement
      return {
        shiftLeft: shiftBtn?.getBoundingClientRect().left ?? -1,
        shiftRight: shiftBtn?.getBoundingClientRect().right ?? -1,
        shiftWidth: shiftBtn?.getBoundingClientRect().width ?? -1,
        cartLeft: cart ? cart.getBoundingClientRect().left : -1,
        padBottom: parseFloat(getComputedStyle(scroller).paddingBottom),
        vw: window.innerWidth,
      }
    })
    if (vp === 'pos-a9') assert(geo.cartLeft > 0 && geo.shiftRight <= geo.cartLeft + 0.5, `${vp}: the Shift pill ends at the catalogue/cart edge, not across it (right ${geo.shiftRight}, cart ${geo.cartLeft})`)
    if (vp === 'pos-a9') assert(geo.shiftWidth >= 90, `${vp}: the Shift pill keeps its label (width ${geo.shiftWidth})`)
    if (vp === 'pos-a9-portrait') assert(geo.padBottom >= 80, `${vp}: the catalogue clears the bottom bar (padding-bottom ${geo.padBottom})`)
    out[vp] = { before, opened, geo }
    // Close the cart again: the thumb must follow the re-flow back (the two-column layout only exists in landscape).
    if (vp !== 'pos-a9') continue
    await page.getByRole('button', { name: 'Kosongkan' }).first().click()
    await page.locator('[role=dialog],[role=alertdialog]').getByRole('button', { name: 'Kosongkan', exact: true }).click()
    await page.getByRole('button', { name: /^Ubah Filler 01(?!\d)/ }).waitFor({ state: 'detached' })
    await settle(page)
    const closed = await thumbGap(page)
    assert(closed.dx < 1 && closed.dw < 1, `${vp}: thumb under its tab after the cart closed (${JSON.stringify(closed)})`)
    out[`${vp}-closed`] = closed
  }
  return out
}
