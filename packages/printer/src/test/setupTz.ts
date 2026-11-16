// Fail loudly if the Jakarta timezone did not apply (it can be ignored on some platforms), because every
// hex golden depends on it.
process.env.TZ = 'Asia/Jakarta'

const probe = new Date('2026-05-29T00:00:00Z').toLocaleString('id-ID', {
  day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
})
// The separator between date and time ("29/05/26, 07.00" vs "29/05/26 07.00") depends on the ICU build; the
// hour is what proves the timezone applied.
if (!/^29\/05\/26,? 07[.:]00$/.test(probe)) {
  throw new Error(`Test timezone/ICU not as expected (Asia/Jakarta, id-ID): got "${probe}"`)
}
