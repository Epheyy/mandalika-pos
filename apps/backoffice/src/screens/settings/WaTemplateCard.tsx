import { useEffect, useRef, useState } from 'react'
import type { WaReceiptTemplate } from '@mandalika/api'
import { WA_SAMPLE_VALUES, renderWaTemplate, validateWaTemplate } from '@mandalika/types'
import { api } from '../../api'
import { Button } from '../../ui/Button'
import { Textarea } from '../../ui/Field'
import { useToast } from '../../ui/Toast'
import { SettingsCard } from './SettingsCard'
import {
  WA_PLACEHOLDER_HINTS, WA_TEMPLATE_MAX_RUNES, canSaveTemplate, insertAtCursor, templateLength,
} from './waTemplateEdit'

interface ViewProps {
  draft: string
  saved: string
  loading: boolean
  saving: boolean
  loadError: string | null
  saveError: string | null
  onChange: (v: string) => void
  /** Called with the chip token; the card inserts it at the textarea caret. */
  onInsert: (token: string) => void
  onReset: () => void
  onSave: () => void
  ref?: React.Ref<HTMLTextAreaElement>
}

/** Presentational card: editor, chips, WhatsApp-style preview, actions. */
export function WaTemplateCardView({ ref, ...p }: ViewProps) {
  const error = validateWaTemplate(p.draft)
  const count = templateLength(p.draft)
  const canSave = !p.loading && !p.saving && canSaveTemplate(p.draft, p.saved)
  return (
    <SettingsCard changed={!p.loading && p.draft !== p.saved} title="Template WhatsApp Struk" className="max-w-4xl space-y-4 p-6">
      <p className="text-xs text-ink-700">Pesan yang dibuka di WhatsApp kasir setelah penjualan. {'{tautan}'} wajib ada.</p>
      {p.loadError && <p role="alert" className="text-sm font-bold text-danger">Gagal memuat template: {p.loadError}</p>}
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="space-y-3">
          <Textarea
            label="Isi pesan"
            rows={9}
            ref={ref}
            value={p.draft}
            disabled={p.loading}
            onChange={(e) => p.onChange(e.target.value)}
            error={p.draft !== '' ? error : undefined}
            className="resize-y"
          />
          <p className={count > WA_TEMPLATE_MAX_RUNES ? 'text-xs font-bold text-danger' : 'text-xs text-ink-700'}>
            {count}/{WA_TEMPLATE_MAX_RUNES}
          </p>
          <div className="flex flex-wrap gap-2" aria-label="Sisipkan placeholder">
            {WA_PLACEHOLDER_HINTS.map((h) => (
              <button
                key={h.token}
                type="button"
                title={h.hint}
                aria-label={`Sisipkan ${h.token} (${h.hint})`}
                onClick={() => p.onInsert(h.token)}
                className="rounded-lg bg-paper-1 px-2.5 py-1 font-mono text-xs font-bold text-ink-900 hover:bg-paper-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-strong"
              >
                {h.token}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="mb-1.5 text-[13px] font-bold text-ink-700">Pratinjau</p>
          <div className="rounded-2xl bg-[#e7ddd3] p-4">
            <div className="ml-auto max-w-sm rounded-2xl rounded-tr-sm bg-[#d9fdd3] px-3 py-2 text-sm text-ink-900 shadow-sm">
              <p data-testid="wa-preview" className="whitespace-pre-wrap break-words">{renderWaTemplate(p.draft, WA_SAMPLE_VALUES)}</p>
            </div>
          </div>
          <p className="mt-1 text-xs text-ink-500">Contoh nilai: pelanggan Budi Santoso, sales Rina, Mandalika BSD.</p>
        </div>
      </div>
      {p.saveError && <p role="alert" className="text-sm font-bold text-danger">{p.saveError}</p>}
      <div className="flex flex-wrap gap-2">
        <Button onClick={p.onSave} disabled={!canSave}>{p.saving ? 'Menyimpan…' : 'Simpan'}</Button>
        <Button variant="secondary" onClick={p.onReset} disabled={p.loading || p.saving}>Kembalikan default</Button>
      </div>
    </SettingsCard>
  )
}

/** Pengaturan > Struk: the WhatsApp receipt message. Own load/save (not the settings draft). */
export function WaTemplateCard() {
  const toast = useToast()
  const [info, setInfo] = useState<WaReceiptTemplate | null>(null)
  const [draft, setDraft] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const caret = useRef<number | null>(null)
  const area = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    let live = true
    api.getWaReceiptTemplate().then(
      (t) => { if (live) { setInfo(t); setDraft(t.template) } },
      (e: unknown) => { if (live) setLoadError(e instanceof Error ? e.message : 'Gagal memuat') },
    )
    return () => { live = false }
  }, [])

  // Put the caret after an inserted chip once React has rendered the new value.
  useEffect(() => {
    if (caret.current === null || !area.current) return
    area.current.focus()
    area.current.setSelectionRange(caret.current, caret.current)
    caret.current = null
  }, [draft])

  const insert = (token: string) => {
    const el = area.current
    const r = insertAtCursor(draft, el?.selectionStart ?? draft.length, el?.selectionEnd ?? draft.length, token)
    caret.current = r.caret
    setDraft(r.text)
  }

  const save = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const t = await api.updateWaReceiptTemplate(draft)
      setInfo(t)
      setDraft(t.template)
      toast({ message: 'Template WhatsApp disimpan.', tone: 'ok' })
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : 'Gagal menyimpan template.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <WaTemplateCardView
        draft={draft}
        saved={info?.template ?? ''}
        loading={info === null && loadError === null}
        saving={saving}
        loadError={loadError}
        saveError={saveError}
        onChange={setDraft}
        onInsert={insert}
        onReset={() => setDraft(info?.defaultTemplate ?? draft)}
        onSave={() => void save()}
        ref={area}
      />
  )
}
