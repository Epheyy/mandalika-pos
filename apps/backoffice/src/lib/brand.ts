// Hoisted once: Intl constructors allocate locale-data tables per call.
const IDR_FORMAT = new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
})

export const BRAND = {
  name: 'Mandalika',
  tagline: 'Your Scent, Your Statement',
  logo: 'M',
  logoUrl:
    'https://mandalikaperfume.co.id/wp-content/uploads/2025/02/GOLD-Tanpa-Text-Bawah.png',

  currency: {
    code: 'IDR',
    symbol: 'Rp',
    locale: 'id-ID',
    format: (amount: number) => IDR_FORMAT.format(amount),
  },

  colors: {
    primary: 'indigo',
    primaryHex: '#b07d18',
    dark: '#1a1008',
  },
}
