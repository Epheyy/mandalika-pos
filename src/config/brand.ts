export const BRAND = {
  name: 'Mandalika',
  tagline: 'Your Scent, Your Statement',
  logo: 'M',

  // Logo image URL — uses actual Mandalika gold logo
  logoUrl: 'https://mandalikaperfume.co.id/wp-content/uploads/2025/02/GOLD-Tanpa-Text-Bawah.png',

  // Currency settings (Indonesia)
  currency: {
    code: 'IDR',
    symbol: 'Rp',
    locale: 'id-ID',
    format: (amount: number) =>
      new Intl.NumberFormat('id-ID', {
        style: 'currency',
        currency: 'IDR',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }).format(amount),
  },

  // Tax settings
  tax: {
    enabled: true,
    rate: 0.11,
    label: 'PPN 11%',
  },

  // Loyalty points
  loyalty: {
    enabled: true,
    pointsPerRupiah: 1,
    pointsThreshold: 1000,
    redemptionRate: 100,
  },

  // Theme
  colors: {
    primary: 'indigo',      // Tailwind class prefix (now gold via CSS override)
    primaryHex: '#b07d18',  // Actual hex value
    dark: '#1a1008',        // Dark background accent
  }
}