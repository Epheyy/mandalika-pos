// Promo auto-apply: an Otomatis promo enters the cart on its own, the cashier's x dismisses it for the sale
// (through a qty change, hold + resume and a reload), and "+ Tambah" brings it back as a normal manual promo.
import type { ScenarioPage } from './fixture'

const assert = (v: unknown, m: string) => { if (!v) throw Error(m) }
const body = (page: ScenarioPage) => page.locator('body').innerText()
const addScent = async (page: ScenarioPage) => {
  await page.getByRole('searchbox').fill('SYN-M')
  await page.getByRole('searchbox').press('Enter')
  await page.getByRole('button', { name: 'Ubah Synthetic Scent M', exact: true }).waitFor()
}
const promoRow = (page: ScenarioPage) => page.getByRole('button', { name: 'Hapus promo', exact: true })
// Absence is asserted after the cart reached its final state and the reconcile had a few frames to run.
const settle = (page: ScenarioPage) => page.waitForTimeout(700)

// POS-AUTO-PROMO
export const posAutoPromo = async (page: ScenarioPage) => {
  const out: any[] = []
  await addScent(page)
  await promoRow(page).waitFor()
  assert((await body(page)).includes('Otomatis Sepuluh'), 'the auto promo enters the cart on its own')
  assert((await page.getByText('Otomatis', { exact: true }).count()) === 1, 'the entry carries the Otomatis tag')
  out.push({ entered: 'Otomatis Sepuluh is in the cart without a tap, tagged Otomatis' })

  await promoRow(page).click()
  await promoRow(page).waitFor({ state: 'detached' })
  await addScent(page) // second unit: the cart changed, the dismissed promo must stay out
  await page.waitForFunction(() => document.body.innerText.includes('200.000'))
  await settle(page)
  assert((await promoRow(page).count()) === 0 && !(await body(page)).includes('Otomatis Sepuluh'), 'the removed auto promo stays out after a quantity change')
  out.push({ dismissed: 'x removes it and it stays removed through a cart edit' })

  // Hold and resume: the dismissed set rides in the held order.
  await page.getByRole('button', { name: 'Simpan keranjang', exact: true }).click()
  await page.getByRole('button', { name: 'Simpan pesanan', exact: true }).click()
  await page.getByRole('button', { name: /^Pesanan tersimpan/ }).click()
  await page.getByRole('button', { name: /^Lanjutkan / }).click()
  await page.getByRole('button', { name: 'Ubah Synthetic Scent M', exact: true }).waitFor()
  await settle(page)
  assert((await promoRow(page).count()) === 0, 'the removed auto promo does not come back after hold and resume')
  out.push({ held: 'still removed after hold + resume' })

  // Reload: the open-cart draft carries the dismissed set too.
  await page.reload()
  await page.getByRole('button', { name: 'Ubah Synthetic Scent M', exact: true }).waitFor()
  await settle(page)
  assert((await promoRow(page).count()) === 0, 'the removed auto promo does not come back after a reload')
  out.push({ reloaded: 'still removed after a reload' })

  // "+ Tambah" is a normal manual apply: the promo is back, without the Otomatis tag.
  await page.getByRole('button', { name: 'Promo & Diskon', exact: true }).click()
  await page.getByRole('button').filter({ hasText: 'Otomatis Sepuluh' }).last().click()
  await promoRow(page).first().waitFor()
  assert((await page.getByText('Otomatis', { exact: true }).count()) === 0, 'a promo added by hand is manual: no Otomatis tag')
  out.push({ readded: '+ Tambah re-adds it as a manual promo' })
  return out
}
