// Kaca P6a: the catalogue scrolls under ONE glass band (header zone + search + categories), the cart column stays solid.
// Asserted at the real fleet tablet size (1006x601, `lg:` off, cart w-80) and at 1280x800. Screenshots go through shots.ts
// (no baselines).
import type { ScenarioPage } from './fixture'
import { POS_BOTH_SHOT_VIEWPORTS, SHOT_VIEWPORTS, captureShot, type ShotViewport } from './shots'

const assert = (v: unknown, m: string) => { if (!v) throw Error(m) }
const shot = async (page: ScenarioPage, name: string) => {
  if (process.env.A34C_RUN_DIR) await captureShot(page as any, name, POS_BOTH_SHOT_VIEWPORTS)
}
const fill = (n: number) => `Filler ${String(n).padStart(2, '0')}`
const addFiller = async (page: ScenarioPage, n: number) => {
  await page.getByRole('button', { name: new RegExp(`^${fill(n)}(?!\\d)`) }).first().click()
  await page.getByRole('button', { name: new RegExp(`^Ubah ${fill(n)}(?!\\d)`) }).waitFor()
}
const settle = (page: ScenarioPage) => page.evaluate(async () => {
  await document.fonts.ready
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
})

const geometry = (page: ScenarioPage) => page.evaluate(() => {
  const band = document.querySelector('[data-kaca-band]') as HTMLElement
  const scroller = document.querySelector('[data-kaca-scroller]') as HTMLElement
  const bandRect = band.getBoundingClientRect()
  const filterOf = (el: Element) => {
    const c = getComputedStyle(el)
    return c.backdropFilter || (c as unknown as Record<string, string>).webkitBackdropFilter || 'none'
  }
  let blurred = 0
  document.querySelectorAll('*').forEach((el) => { if (filterOf(el) !== 'none') blurred++ })
  const tiles = [...scroller.querySelectorAll('.grid > *')].map((t) => t.getBoundingClientRect())
  return {
    bandBottom: bandRect.bottom,
    bandFilter: filterOf(band),
    blurred,
    scrollTop: scroller.scrollTop,
    firstTileTop: tiles[0]?.top ?? -1,
    underBand: tiles.filter((r) => r.top < bandRect.bottom && r.bottom > bandRect.bottom).length,
    scrollable: scroller.scrollHeight > scroller.clientHeight + 40,
  }
})

export const posGlassBand = async (page: ScenarioPage) => {
  const out: any[] = []
  for (const vp of ['pos-a9', 'pos'] as ShotViewport[]) {
    await page.setViewportSize(SHOT_VIEWPORTS[vp])
    await settle(page)
    // Rest: first row not covered, the band is the one blurred layer.
    const rest = await geometry(page)
    assert(/blur/.test(rest.bandFilter), `${vp}: the band has a computed backdrop-filter blur (got ${rest.bandFilter})`)
    assert(rest.blurred === 1, `${vp}: exactly one blurred layer on the POS (got ${rest.blurred})`)
    assert(rest.scrollTop === 0, `${vp}: the scroller rests at 0`)
    assert(rest.firstTileTop >= rest.bandBottom - 0.5, `${vp}: the first product row is not covered at scroll 0 (tile top ${rest.firstTileTop} vs band bottom ${rest.bandBottom})`)
    assert(rest.scrollable, `${vp}: the filler catalogue scrolls`)
    // Scrolled: tiles pass under the band.
    await page.evaluate(() => { (document.querySelector('[data-kaca-scroller]') as HTMLElement).scrollTop = 260 })
    await settle(page)
    const scrolled = await geometry(page)
    assert(scrolled.underBand > 0, `${vp}: scrolled tiles sit under the band`)
    assert(scrolled.blurred === 1, `${vp}: still one blurred layer while scrolled`)
    if (vp === 'pos') await shot(page, 'p6a-scrolled-under-band')
    await page.evaluate(() => { (document.querySelector('[data-kaca-scroller]') as HTMLElement).scrollTop = 0 })
    out.push({ viewport: vp, bandBottom: rest.bandBottom, firstTileTop: rest.firstTileTop, tilesUnderBandWhenScrolled: scrolled.underBand })
  }

  // The one-line fallback: static material = the same tint with no blur anywhere.
  await page.evaluate(() => { document.documentElement.dataset.material = 'static' })
  const fallback = await geometry(page)
  assert(fallback.bandFilter === 'none' && fallback.blurred === 0, 'data-material=static removes the blur')
  await page.evaluate(() => { document.documentElement.dataset.material = 'glass' })
  out.push({ fallback: 'data-material=static -> no backdrop-filter anywhere' })

  await page.setViewportSize(SHOT_VIEWPORTS['pos-a9'])
  await settle(page)
  await shot(page, 'p6a-empty-cart')

  // 1 line, then 12 lines: the cart column mounts, the band stays the only blur.
  await addFiller(page, 1)
  await shot(page, 'p6a-1-line')
  const withCart = await geometry(page)
  assert(withCart.blurred === 1, 'one blurred layer with the cart mounted')
  assert(withCart.firstTileTop >= withCart.bandBottom - 0.5, 'the first row stays uncovered after the cart mounts')
  for (let n = 2; n <= 12; n++) await addFiller(page, n)
  await shot(page, 'p6a-12-lines')
  const bayar = await page.getByRole('button', { name: 'Bayar', exact: true }).boundingBox()
  const vh = SHOT_VIEWPORTS['pos-a9'].height
  assert(bayar && bayar.y >= 0 && bayar.y + bayar.height <= vh + 0.5, 'Bayar stays inside the 601 px viewport with 12 lines')
  out.push({ lines: 12 })
  return out
}

// A second pass with the auto promo: promo lines in the cart (Otomatis tag, Hemat promo).
export const posGlassPromoLines = async (page: ScenarioPage) => {
  await page.setViewportSize(SHOT_VIEWPORTS['pos-a9'])
  await settle(page)
  await addFiller(page, 1)
  await addFiller(page, 2)
  await page.getByRole('button', { name: 'Hapus promo', exact: true }).waitFor()
  assert((await page.getByText('Otomatis', { exact: true }).count()) === 1, 'the Otomatis tag shows in the cart')
  await shot(page, 'p6a-promo-lines')
  return [{ promoLines: 'Otomatis Sepuluh in the cart' }]
}
