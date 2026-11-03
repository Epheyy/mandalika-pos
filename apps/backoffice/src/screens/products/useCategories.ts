import { useEffect, useState } from 'react'
import type { Category } from '@mandalika/api'
import { api } from '../../api'

export interface CategoryForm {
  name: string
  description: string
}

const EMPTY_CATEGORY: CategoryForm = { name: '', description: '' }
const errorText = (e: unknown, fallback: string): string => (e instanceof Error && e.message ? e.message : fallback)

/**
 * Create, edit and delete categories. The form's error is its own (shown inside the category form, never in the
 * product editor); a refused delete keeps the confirm dialog open with the server's reason.
 */
export function useCategoryManager(refetch: () => Promise<unknown>) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Category | null>(null)
  const [form, setForm] = useState<CategoryForm>(EMPTY_CATEGORY)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<Category | null>(null)
  const [delErr, setDelErr] = useState<string | null>(null)
  const [delBusy, setDelBusy] = useState(false)

  const openNew = () => {
    setEditing(null)
    setForm(EMPTY_CATEGORY)
    setErr(null)
    setOpen(true)
  }
  const openEdit = (c: Category) => {
    setEditing(c)
    setForm({ name: c.name, description: c.description || '' })
    setErr(null)
    setOpen(true)
  }
  const close = () => {
    if (!busy) setOpen(false)
  }

  const save = async () => {
    if (!form.name.trim()) return setErr('Nama kategori wajib diisi')
    setBusy(true)
    setErr(null)
    try {
      if (editing) await api.updateCategory(editing.id, form)
      else await api.createCategory(form)
      setOpen(false)
      await refetch()
    } catch (e: unknown) {
      setErr(errorText(e, 'Gagal menyimpan kategori.'))
    } finally {
      setBusy(false)
    }
  }

  const askDelete = (c: Category) => {
    setDelErr(null)
    setDeleting(c)
  }
  const cancelDelete = () => {
    if (!delBusy) setDeleting(null)
  }
  // A second click while the request runs would 404 and leave that error on the next dialog, so delBusy blocks it.
  const confirmDelete = async () => {
    if (!deleting) return
    setDelBusy(true)
    try {
      await api.deleteCategory(deleting.id)
    } catch (e: unknown) {
      setDelErr(errorText(e, 'Gagal menghapus kategori.'))
      return
    } finally {
      setDelBusy(false)
    }
    setDeleting(null)
    await refetch()
  }

  return {
    open, editing, form, setForm, busy, err, openNew, openEdit, close, save,
    deleting, delErr, delBusy, askDelete, cancelDelete, confirmDelete,
  }
}

/**
 * Products per category, for the Kategori tab. The product list is paged on the server, so each count is the
 * `total` of a one-row page filtered to that category. Fetched once per visit (not polled); null = unknown.
 */
export function useCategoryCounts(categories: readonly Category[]): Readonly<Record<string, number | null>> {
  const [counts, setCounts] = useState<Record<string, number | null>>({})
  const idsKey = categories.map((c) => c.id).join(',')
  useEffect(() => {
    if (!idsKey) return
    let alive = true
    const ids = idsKey.split(',')
    void Promise.all(
      ids.map((categoryId) =>
        api.listProducts(1, 1, { categoryId }).then((r) => [categoryId, r.meta?.total ?? null] as const).catch(() => [categoryId, null] as const),
      ),
    ).then((pairs) => {
      if (alive) setCounts(Object.fromEntries(pairs))
    })
    return () => {
      alive = false
    }
  }, [idsKey])
  return counts
}
