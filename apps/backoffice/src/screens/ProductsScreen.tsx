import { useEffect, useState } from 'react'
import type { Product } from '@mandalika/api'
import { api } from '../api'

// First screen running read-only against Go (Phase B exit criterion).
export default function ProductsScreen() {
  const [products, setProducts] = useState<Product[]>([])
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api
      .listProducts(1, 50)
      .then((r) => {
        setProducts(r.data)
        setTotal(r.meta?.total ?? r.data.length)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'load failed'))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <p>Loading products…</p>
  if (error) return <p style={{ color: 'crimson' }}>Error: {error}</p>

  return (
    <section>
      <h2>Products ({total})</h2>
      {products.length === 0 ? (
        <p>No products yet.</p>
      ) : (
        <table cellPadding={6}>
          <thead>
            <tr>
              <th align="left">Name</th>
              <th align="left">Brand</th>
              <th align="left">Variants</th>
              <th align="left">Active</th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>{p.brand}</td>
                <td>{p.variants.length}</td>
                <td>{p.isActive ? 'yes' : 'no'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
