// P-20 open cart survives a reload: rendered POS against the synthetic API.
import type { ScenarioPage } from './fixture'

const OUTLET = '00000000-0000-4000-8300-000000000090'
const KEY = `mandalika.pos.openCart.${OUTLET}`
const assert = (v: unknown, m: string) => { if (!v) throw Error(m) }
const storedOutbox = (page: ScenarioPage) =>
  page.evaluate(() => Object.keys(localStorage).filter((k) => /outbox/i.test(k)).map((k) => localStorage.getItem(k) ?? '').join('\n'))
const ready = (page: ScenarioPage) => page.getByRole('button', { name: /^Synthetic Scent/ }).first().waitFor()

// POS-OPEN-CART
export const posOpenCart = async (page: ScenarioPage) => {
  const out: any[] = []
  await page.getByRole('searchbox').fill('SYN-M')
  await page.getByRole('searchbox').press('Enter')
  await page.getByRole('button', { name: 'Ubah Synthetic Scent M', exact: true }).waitFor()
  await page.waitForFunction((k) => !!localStorage.getItem(k), KEY)
  const draftRaw = await page.evaluate((k) => localStorage.getItem(k), KEY)
  const uuid = JSON.parse(draftRaw!).saleUuid as string
  out.push({ saved: 'draft written when the item was added' })

  await page.reload()
  await ready(page)
  await page.getByRole('button', { name: 'Ubah Synthetic Scent M', exact: true }).waitFor()
  out.push({ restored: 'the cart line is back after a reload' })

  // Pay (QRIS, exact) with the network down so the sale stays in the outbox.
  page.__a24.netDown = true
  await page.getByRole('button', { name: 'Bayar', exact: true }).click()
  await page.getByRole('button', { name: 'QRIS', exact: true }).click()
  await page.getByRole('button', { name: /^Konfirmasi Rp/ }).click()
  await page.getByRole('heading', { name: 'Pembayaran Berhasil' }).waitFor()
  assert((await page.evaluate((k) => localStorage.getItem(k), KEY)) === null, 'the draft is deleted once the sale is queued')
  const count = async () => {
    const t = await storedOutbox(page)
    return { sales: t.split('"type":"order"').length - 1, withUuid: t.split(`"orderUuid":"${uuid}"`).length - 1 }
  }
  const before = await count()
  assert(before.sales === 1 && before.withUuid === 1, 'one queued sale carrying the cart uuid: ' + JSON.stringify(before))

  // Lost delete (killed between the enqueue and the delete): the stale draft must not bring the paid cart back.
  await page.evaluate(([k, v]) => localStorage.setItem(k as string, v as string), [KEY, draftRaw!])
  await page.reload()
  await ready(page)
  assert((await page.getByRole('button', { name: 'Ubah Synthetic Scent M', exact: true }).count()) === 0, 'a paid cart does not reappear')
  const after = await count()
  assert(after.sales === 1 && after.withUuid === 1, 'still exactly one queued sale: ' + JSON.stringify(after))
  await page.waitForFunction((k) => localStorage.getItem(k) === null, KEY)
  out.push({ lostDelete: 'stale draft dropped, no cart, one queued sale' })
  return out
}
