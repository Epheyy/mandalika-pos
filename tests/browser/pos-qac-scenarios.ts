// QA wave C (2026-11-08) + full-cart header (2026-11-08): with the cart open (1006x601) the cart column runs from the
// viewport top and every header control (search, Shift, Online, Menu) ends at or left of its edge, with no outlet
// name in the header; the cart header's count never meets Tersimpan/Simpan (U6); the category thumb stays under its
// tab after the cart opens/closes (U1); in portrait the last product row clears the bottom bar (F25). Shots
// (A34C_RUN_DIR only) feed the side-by-side with the Kaca mock; no baselines.
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
    if (vp === 'pos-a9') {
      // Park the line so Tersimpan (1) shows in the cart header, then add it again.
      const sheet = page.getByTestId('held-orders-sheet')
      await page.getByRole('button', { name: 'Simpan keranjang', exact: true }).click()
      await sheet.waitFor()
      await sheet.getByRole('button', { name: 'Simpan pesanan', exact: true }).click()
      await sheet.waitFor({ state: 'detached' })
      await page.getByRole('button', { name: /^Filler 01(?!\d)/ }).first().click()
    }
    // Portrait (< sm) keeps the cart on its own tab: the bottom bar appears instead of the cart column.
    if (vp === 'pos-a9') await page.getByRole('button', { name: /^Ubah Filler 01(?!\d)/ }).waitFor()
    else await page.getByRole('button', { name: /^Keranjang/ }).waitFor()
    await settle(page)
    const opened = await thumbGap(page)
    assert(opened.dx < 1 && opened.dw < 1, `${vp}: thumb still under its tab after the cart opened (${JSON.stringify(opened)})`)
    await shot(page, `qac-${vp}-cart-open`, vp)
    const geo = await page.evaluate(() => {
      const box = (el: Element | null | undefined) => { const r = el?.getBoundingClientRect(); return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null }
      const header = document.querySelector('header') as HTMLElement
      const shiftBtn = [...header.querySelectorAll('button')].find((b) => /^Shift/.test(b.textContent?.trim() ?? ''))
      const cart = [...document.querySelectorAll('[data-kaca-scroller]')][0]?.closest('div.min-w-0')?.nextElementSibling as HTMLElement | null
      const scroller = document.querySelector('[data-kaca-scroller]') as HTMLElement
      const controls = {
        search: box(header.querySelector('input')?.closest('div')),
        shift: box(shiftBtn),
        online: box([...header.querySelectorAll('button')].find((b) => /Online|Offline|Tersinkron|Menunggu/.test(b.textContent ?? ''))),
        menu: box(header.querySelector('button[aria-label=Menu]')),
      }
      const heading = [...document.querySelectorAll('h2')].find((h) => h.textContent?.trim() === 'Pesanan')
      const count = [...document.querySelectorAll('p')].find((x) => /^\d+ barang$/.test(x.textContent?.trim() ?? ''))
      const held = [...document.querySelectorAll('button')].find((b) => /^Tersimpan \(\d+\)/.test(b.textContent?.trim() ?? ''))
      const save = document.querySelector('button[aria-label="Simpan keranjang"]')
      const hit = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) => !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
      // Stress the count at 99 items: swap the text, re-measure, restore.
      let overlap99 = false
      if (count) {
        const was = count.textContent
        count.textContent = '99 barang'
        const c99 = box(count)
        overlap99 = hit(c99, box(held)) || hit(c99, box(save)) || hit(c99, box(heading))
        count.textContent = was
      }
      const cb = box(count)
      const sb = box(shiftBtn)
      // Visible text only (the sr-only " aktif" span would inflate scrollWidth): do the label's own text nodes fit?
      const clipped = (el: HTMLElement) => {
        const range = document.createRange()
        let right = 0
        for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) { range.selectNodeContents(n); right = Math.max(right, range.getBoundingClientRect().right) }
        return right > el.getBoundingClientRect().right + 1
      }
      const shiftLabel = shiftBtn?.querySelector('span.truncate') as HTMLElement | null
      return {
        controls,
        outletInHeader: !!header.querySelector('[title="Outlet terminal"]'),
        shiftWidth: sb ? sb.right - sb.left : -1,
        shiftClipped: shiftLabel ? clipped(shiftLabel) : true,
        cartLeft: cart ? cart.getBoundingClientRect().left : -1,
        cartTop: cart ? cart.getBoundingClientRect().top : -1,
        sat: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sat')) || 0,
        countOverlaps: { held: hit(cb, box(held)), save: hit(cb, box(save)), heading: hit(cb, box(heading)), at99: overlap99 },
        hasHeld: !!held, hasCount: !!count,
        padBottom: parseFloat(getComputedStyle(scroller).paddingBottom),
        vw: window.innerWidth,
      }
    })
    if (vp === 'pos-a9') {
      const g = geo as any
      assert(g.cartLeft > 0, `${vp}: cart column found`)
      for (const [name, bx] of Object.entries(g.controls as Record<string, { right: number } | null>)) {
        assert(bx, `${vp}: header control ${name} found`)
        assert(bx!.right <= g.cartLeft + 0.5, `${vp}: header ${name} ends at or left of the cart column (right ${bx!.right}, cart ${g.cartLeft})`)
      }
      assert(g.cartTop <= g.sat + 8, `${vp}: the cart column starts at the viewport top (top ${g.cartTop}, inset ${g.sat})`)
      assert(!g.outletInHeader, `${vp}: no outlet name in the header`)
      assert(g.hasHeld && g.hasCount, `${vp}: Tersimpan and the item count are both shown`)
      assert(!g.countOverlaps.held && !g.countOverlaps.save && !g.countOverlaps.heading && !g.countOverlaps.at99, `${vp}: the cart header count does not meet Pesanan/Tersimpan/Simpan (${JSON.stringify(g.countOverlaps)})`)
      assert(!g.shiftClipped, `${vp}: the Shift pill keeps its full label (width ${g.shiftWidth})`)
    }
    if (vp === 'pos-a9-portrait') {
      assert(geo.padBottom >= 80, `${vp}: the catalogue clears the bottom bar (padding-bottom ${geo.padBottom})`)
      assert(!geo.shiftClipped, `${vp}: the portrait Shift pill keeps its full label (width ${geo.shiftWidth})`)
    }
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
