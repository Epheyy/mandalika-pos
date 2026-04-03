// ============================================
// 🎨 BRAND CONFIG — Change this per brand
// When building for Performance or Flamboyan,
// only this file needs to change.
// ============================================

export const BRAND = {
  name: 'Mandalika',
  tagline: 'Luxury Perfume',
  logo: 'M',
  
  // Currency settings (Indonesia)
  currency: {
    code: 'IDR',
    symbol: 'Rp',
    locale: 'id-ID',
    // Format: Rp 150.000
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
    rate: 0.11, // 11% PPN Indonesia
    label: 'PPN 11%',
  },

  // Loyalty points
  loyalty: {
    enabled: true,
    pointsPerRupiah: 1,      // 1 point per Rp 1.000 spent
    pointsThreshold: 1000,   // minimum spend to earn points
    redemptionRate: 100,     // 100 points = Rp 1.000 discount
  },

  // Theme color (Tailwind class names)
  colors: {
    primary: 'indigo',
    primaryHex: '#6366f1',
  }
}