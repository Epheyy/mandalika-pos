import { useEffect, useMemo, useRef, useState } from 'react'
import type { Customer } from '@mandalika/api'
import { normalizePhone } from '@mandalika/types'
import { api } from '../../api'
import { useRoute } from '../../lib/router/useRoute'
import { useUnsavedChanges } from '../../lib/useUnsavedChanges'
import { useConfirm } from '../../ui/ConfirmDialog'
import { useToast } from '../../ui/Toast'
import { CustomerFormSlideOver } from './CustomerFormSlideOver'
import {
  EMPTY_CUSTOMER_FORM,
  customerBodyOf,
  customerFormErrors,
  formOfCustomer,
  isCustomerFormDirty,
  type CustomerForm,
} from './customerForm'

interface CustomerEditorHostProps {
  /** The customer to edit, or null for a new one. */
  customer: Customer | null
  /** Called after a successful save (refetch the list), before the panel closes. */
  onSaved: () => Promise<unknown>
  onClose: () => void
}

/**
 * The customer edit panel. Mounted only while it is open, so nothing needs resetting. Unsaved changes are guarded by ONE
 * question that covers every way out: x, Batal, Escape, the backdrop, browser Back and the sidebar. A save, or an answered
 * "Buang perubahan", closes without asking again.
 */
export function CustomerEditorHost({ customer, onSaved, onClose }: CustomerEditorHostProps) {
  const confirm = useConfirm()
  const toast = useToast()
  const opened = useMemo(() => (customer ? formOfCustomer(customer) : EMPTY_CUSTOMER_FORM), []) // eslint-disable-line react-hooks/exhaustive-deps
  const [form, setFormState] = useState<CustomerForm>(opened)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [phoneDupeName, setPhoneDupeName] = useState<string | null>(null)
  const [tried, setTried] = useState(false)
  const answered = useRef(false)
  const dirty = isCustomerFormDirty(form, opened)
  const editingId = customer?.id ?? null
  const errors = customerFormErrors(form, customer ? opened : undefined)

  const setForm = (patch: Partial<CustomerForm>) => setFormState((f) => ({ ...f, ...patch }))

  // The panel is not part of the URL, so any route move (browser Back, a link) takes an untouched panel down with it;
  // a dirty one was already asked by the guard below, and closes on "Buang perubahan".
  const route = useRoute()
  const here = JSON.stringify([route.path, route.query])
  const openedAt = useRef(here)
  useEffect(() => {
    if (here !== openedAt.current && !dirty) onClose()
  }, [here, dirty, onClose])

  useEffect(() => {
    const phone = form.phone.trim()
    if (!phone) {
      setPhoneDupeName(null)
      return
    }
    let ignore = false
    const t = setTimeout(async () => {
      try {
        const matches = await api.getCustomersByPhone(phone)
        if (!ignore) setPhoneDupeName(matches.find((m) => m.id !== editingId)?.name ?? null)
      } catch {
        // A failed look-up only drops the hint; the save itself is validated by the server.
        if (!ignore) setPhoneDupeName(null)
      }
    }, 300)
    return () => {
      clearTimeout(t)
      ignore = true
    }
  }, [form.phone, editingId])

  const askLeave = async (): Promise<boolean> => {
    if (answered.current || !dirty) return true
    const answer = await confirm({
      title: 'Buang perubahan?',
      consequence: 'Perubahan pada pelanggan ini belum disimpan dan akan hilang.',
      confirmLabel: 'Buang perubahan',
      cancelLabel: 'Lanjut edit',
      tone: 'danger',
    })
    if (answer.confirmed) answered.current = true
    return answer.confirmed
  }
  // A move the guard allowed (Back, sidebar) must also take the panel down when this screen stays mounted.
  useUnsavedChanges(dirty, async () => {
    const ok = await askLeave()
    if (ok) onClose()
    return ok
  })

  const requestClose = async () => {
    if (await askLeave()) onClose()
  }

  /** The name of another customer with this phone (any format), asked fresh at save so a stale hint cannot hide it. */
  const dupeNameNow = async (phone: string): Promise<string | null> => {
    try {
      const matches = await api.getCustomersByPhone(phone)
      return matches.find((m) => m.id !== editingId)?.name ?? null
    } catch {
      return null // the look-up is advisory; the server still validates and flags the pair
    }
  }

  const save = async () => {
    setTried(true)
    if (errors.length > 0) return
    setBusy(true)
    setErr(null)
    try {
      const body = customerBodyOf(form)
      const phoneChanged = !customer || normalizePhone(body.phone) !== normalizePhone(opened.phone)
      const dupeName = phoneChanged ? await dupeNameNow(body.phone) : null
      if (dupeName) {
        const answer = await confirm({
          title: 'Nomor sudah dipakai',
          consequence: `Nomor ini sudah dipakai oleh ${dupeName}. Jika disimpan, kedua pelanggan masuk antrean Duplikat untuk ditinjau.`,
          confirmLabel: 'Tetap simpan',
          cancelLabel: 'Periksa lagi',
        })
        if (!answer.confirmed) return
      }
      if (customer) await api.updateCustomer(customer.id, body)
      else await api.createCustomer(body)
      answered.current = true
      await onSaved()
      toast({ message: customer ? 'Pelanggan disimpan.' : 'Pelanggan ditambahkan.', tone: 'ok' })
      onClose()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal menyimpan pelanggan.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <CustomerFormSlideOver
      editing={customer !== null}
      form={form}
      setForm={setForm}
      dirty={dirty}
      busy={busy}
      err={err}
      errors={tried ? errors : []}
      phoneDupeName={phoneDupeName}
      onSave={() => void save()}
      onClose={() => void requestClose()}
    />
  )
}
