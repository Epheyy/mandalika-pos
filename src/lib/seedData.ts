import { db } from '../firebase'
import { collection, addDoc, getDocs, query, limit } from 'firebase/firestore'

export async function seedDatabase(): Promise<string> {
  // Check if data already exists
  const existing = await getDocs(query(collection(db, 'products'), limit(1)))
  if (!existing.empty) {
    return 'Data sudah ada! Hapus koleksi products & categories di Firestore dulu jika ingin reset.'
  }

  // ── Seed Categories ──────────────────────
  const categoryData = [
    { name: 'Floral', description: 'Wangi bunga yang segar dan feminin', sortOrder: 1 },
    { name: 'Woody', description: 'Aroma kayu yang hangat dan maskulin', sortOrder: 2 },
    { name: 'Oriental', description: 'Wangi rempah eksotis yang mewah', sortOrder: 3 },
    { name: 'Fresh', description: 'Aroma segar dan ringan sehari-hari', sortOrder: 4 },
    { name: 'Gourmand', description: 'Wangi manis seperti makanan', sortOrder: 5 },
  ]

  const catIds: Record<string, string> = {}
  for (const cat of categoryData) {
    const ref = await addDoc(collection(db, 'categories'), cat)
    catIds[cat.name] = ref.id
  }

  // ── Seed Outlets ─────────────────────────
  const outlets = [
    { name: 'Mandalika - Tunjungan Plaza', address: 'Tunjungan Plaza Lt.3, Surabaya', phone: '031-5678901', isActive: true, createdAt: new Date().toISOString() },
    { name: 'Mandalika - Galaxy Mall', address: 'Galaxy Mall Lt.2, Surabaya', phone: '031-5678902', isActive: true, createdAt: new Date().toISOString() },
    { name: 'Mandalika - Pakuwon Mall', address: 'Pakuwon Mall Lt.1, Surabaya', phone: '031-5678903', isActive: true, createdAt: new Date().toISOString() },
  ]
  for (const outlet of outlets) {
    await addDoc(collection(db, 'outlets'), outlet)
  }

  // ── Seed Products ────────────────────────
  const products = [
    {
      name: 'Rose Elégante',
      brand: 'Mandalika',
      categoryId: catIds['Floral'],
      description: 'Mawar Turki berpadu dengan peony putih, meninggalkan kesan feminin yang abadi.',
      imageUrl: 'https://images.unsplash.com/photo-1541643600914-78b084683702?w=400&q=80',
      isActive: true,
      isFeatured: true,
      createdAt: new Date().toISOString(),
      variants: [
        { size: '30ml', price: 185000, stock: 24, sku: 'MND-RE-30' },
        { size: '50ml', price: 285000, stock: 18, sku: 'MND-RE-50' },
        { size: '100ml', price: 450000, stock: 10, sku: 'MND-RE-100' },
      ],
    },
    {
      name: 'Jasmine Noir',
      brand: 'Mandalika',
      categoryId: catIds['Floral'],
      description: 'Melati malam yang intens, dibalut musk hangat dan sedikit vanilla.',
      imageUrl: 'https://images.unsplash.com/photo-1588514913813-5b7042b28c6e?w=400&q=80',
      isActive: true,
      isFeatured: false,
      createdAt: new Date().toISOString(),
      variants: [
        { size: '30ml', price: 175000, stock: 30, sku: 'MND-JN-30' },
        { size: '50ml', price: 265000, stock: 20, sku: 'MND-JN-50' },
        { size: '100ml', price: 420000, stock: 8, sku: 'MND-JN-100' },
      ],
    },
    {
      name: 'Cedar & Oud',
      brand: 'Mandalika',
      categoryId: catIds['Woody'],
      description: 'Kayu cedar Atlantik bertemu oud Timur Tengah, maskulin dan berwibawa.',
      imageUrl: 'https://images.unsplash.com/photo-1592945403244-b3fbafd7f539?w=400&q=80',
      isActive: true,
      isFeatured: true,
      createdAt: new Date().toISOString(),
      variants: [
        { size: '50ml', price: 320000, stock: 15, sku: 'MND-CO-50' },
        { size: '100ml', price: 520000, stock: 7, sku: 'MND-CO-100' },
      ],
    },
    {
      name: 'Sandalwood Dusk',
      brand: 'Mandalika',
      categoryId: catIds['Woody'],
      description: 'Cendana Mysore yang creamy dan lembut, cocok untuk dipakai seharian.',
      imageUrl: 'https://images.unsplash.com/photo-1615634260167-c8cdede054de?w=400&q=80',
      isActive: true,
      isFeatured: false,
      createdAt: new Date().toISOString(),
      variants: [
        { size: '30ml', price: 210000, stock: 22, sku: 'MND-SD-30' },
        { size: '50ml', price: 330000, stock: 12, sku: 'MND-SD-50' },
        { size: '100ml', price: 540000, stock: 5, sku: 'MND-SD-100' },
      ],
    },
    {
      name: 'Amber Sultan',
      brand: 'Mandalika',
      categoryId: catIds['Oriental'],
      description: 'Amber Maroko berpadu patchouli dan cengkeh, hangat dan penuh karakter.',
      imageUrl: 'https://images.unsplash.com/photo-1563170351-be82bc888aa4?w=400&q=80',
      isActive: true,
      isFeatured: true,
      createdAt: new Date().toISOString(),
      variants: [
        { size: '30ml', price: 225000, stock: 18, sku: 'MND-AS-30' },
        { size: '50ml', price: 355000, stock: 14, sku: 'MND-AS-50' },
        { size: '100ml', price: 580000, stock: 6, sku: 'MND-AS-100' },
      ],
    },
    {
      name: 'Spice Royale',
      brand: 'Mandalika',
      categoryId: catIds['Oriental'],
      description: 'Rempah cardamom dan safron membungkus musk bersih yang elegan.',
      imageUrl: 'https://images.unsplash.com/photo-1556228578-8c89e6adf883?w=400&q=80',
      isActive: true,
      isFeatured: false,
      createdAt: new Date().toISOString(),
      variants: [
        { size: '50ml', price: 375000, stock: 10, sku: 'MND-SR-50' },
        { size: '100ml', price: 610000, stock: 4, sku: 'MND-SR-100' },
      ],
    },
    {
      name: 'Aqua Breeze',
      brand: 'Mandalika',
      categoryId: catIds['Fresh'],
      description: 'Citrus bergamot dan lemon segar, sempurna untuk aktivitas harian.',
      imageUrl: 'https://images.unsplash.com/photo-1585386959984-a4155224a1ad?w=400&q=80',
      isActive: true,
      isFeatured: false,
      createdAt: new Date().toISOString(),
      variants: [
        { size: '30ml', price: 145000, stock: 40, sku: 'MND-AB-30' },
        { size: '50ml', price: 225000, stock: 28, sku: 'MND-AB-50' },
        { size: '100ml', price: 365000, stock: 15, sku: 'MND-AB-100' },
      ],
    },
    {
      name: 'Green Tea Zen',
      brand: 'Mandalika',
      categoryId: catIds['Fresh'],
      description: 'Teh hijau Jepang dan bambu, menenangkan dan bersih sepanjang hari.',
      imageUrl: 'https://images.unsplash.com/photo-1547887538-047f08e44e1c?w=400&q=80',
      isActive: true,
      isFeatured: false,
      createdAt: new Date().toISOString(),
      variants: [
        { size: '30ml', price: 155000, stock: 35, sku: 'MND-GT-30' },
        { size: '50ml', price: 240000, stock: 25, sku: 'MND-GT-50' },
      ],
    },
    {
      name: 'Vanilla Dream',
      brand: 'Mandalika',
      categoryId: catIds['Gourmand'],
      description: 'Vanilla Madagascar yang creamy, manis namun tidak berlebihan.',
      imageUrl: 'https://images.unsplash.com/photo-1571781926291-c477ebfd024b?w=400&q=80',
      isActive: true,
      isFeatured: true,
      createdAt: new Date().toISOString(),
      variants: [
        { size: '30ml', price: 165000, stock: 28, sku: 'MND-VD-30' },
        { size: '50ml', price: 255000, stock: 20, sku: 'MND-VD-50' },
        { size: '100ml', price: 410000, stock: 9, sku: 'MND-VD-100' },
      ],
    },
    {
      name: 'Caramel Luxe',
      brand: 'Mandalika',
      categoryId: catIds['Gourmand'],
      description: 'Karamel salted butter berpadu tonka bean, mewah dan adiktif.',
      imageUrl: 'https://images.unsplash.com/photo-1601295452898-d2f1dc36e5a8?w=400&q=80',
      isActive: true,
      isFeatured: false,
      createdAt: new Date().toISOString(),
      variants: [
        { size: '30ml', price: 175000, stock: 20, sku: 'MND-CL-30' },
        { size: '50ml', price: 270000, stock: 15, sku: 'MND-CL-50' },
        { size: '100ml', price: 435000, stock: 7, sku: 'MND-CL-100' },
      ],
    },
  ]

  for (const product of products) {
    await addDoc(collection(db, 'products'), product)
  }

  return 'Berhasil! 10 produk, 5 kategori, dan 3 outlet telah ditambahkan.'
}