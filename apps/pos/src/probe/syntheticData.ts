import type { components } from '@mandalika/api'
import logoGold from '../assets/logo-gold.png'
import flamboyan from '../assets/brands/flamboyan-logo-240.webp'
import performance from '../assets/brands/performance-logo-240.webp'

type Product = components['schemas']['Product']
type Category = components['schemas']['Category']

export const PRODUCT_COUNT = 72
const CATEGORY_NAMES = ['Parfum Pria', 'Parfum Wanita', 'Unisex', 'Body Mist', 'Hadiah', 'Aksesori']
const IMAGES = [logoGold, flamboyan, performance]
const NAMES = ['Bunga Malam', 'Kayu Cendana', 'Melati Putih', 'Sore di Pantai', 'Ambar Emas', 'Hujan Pertama', 'Vanila Tua', 'Mawar Biru', 'Teh Hijau', 'Kopi Pagi', 'Pala Hangat', 'Lavender Kabut']

export const categories: Category[] = CATEGORY_NAMES.map((name, i) => ({ id: `cat-${i}`, name, sortOrder: i }))

/** 72 synthetic products, 12 per category. Every third has three sizes; every 7th is out of stock. */
export const products: Product[] = Array.from({ length: PRODUCT_COUNT }, (_, i) => {
  const multi = i % 3 === 0
  const sizes = multi ? ['30ml', '50ml', '100ml'] : ['50ml']
  return {
    id: `prod-${i}`,
    name: `${NAMES[i % NAMES.length]} No. ${i + 1}`,
    brand: 'probe',
    categoryId: `cat-${Math.floor(i / 12)}`,
    imageUrl: IMAGES[i % IMAGES.length],
    variants: sizes.map((size, j) => ({
      id: `v-${i}-${j}`,
      size,
      price: 85000 + j * 70000 + (i % 5) * 5000,
      stock: i % 7 === 0 ? 0 : 3 + ((i + j) % 20),
      sku: `PRB-${i}-${j}`,
    })),
    isFeatured: false,
    isFavourite: false,
    isActive: true,
    createdAt: '2026-01-01T00:00:00Z',
  }
})
