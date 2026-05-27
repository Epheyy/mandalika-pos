// apps/backoffice/src/screens/ingredients/SuratJalanIngredientPanel.tsx
//
// Clone of SP4 SuratJalanPanel adapted for IngredientTransfer.
// Only differences from the product-transfer panel:
//  - Prop type: Transfer → IngredientTransfer
//  - Doc import: SuratJalanDoc → IngredientSuratJalanDoc
//  - render.ts reused unchanged from ../../transfers/docs/render

import { useRef, useState } from 'react'
import { Share2, Download, FileText, Eye } from 'lucide-react'
import type { IngredientTransfer } from '@mandalika/api'
import { Card, Button, Modal } from '../../ui'
import { IngredientSuratJalanDoc } from './docs/IngredientSuratJalanDoc'
import {
  renderNodeToPng,
  pngBlobToPdf,
  shareSuratJalan,
  triggerDownload,
} from '../transfers/docs/render'

interface SuratJalanIngredientPanelProps {
  transfer: IngredientTransfer
}

export function SuratJalanIngredientPanel({ transfer }: SuratJalanIngredientPanelProps) {
  const docRef = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState<null | 'share' | 'pdf' | 'png'>(null)
  const [showPreview, setShowPreview] = useState(false)
  const [info, setInfo] = useState<string | null>(null)

  // Only render once the server has assigned an SJ number (after Send).
  if (!transfer.suratJalanNo) return null

  const baseName = `suratjalan-bahan-${transfer.suratJalanNo}`

  async function withNode<T>(fn: (node: HTMLElement) => Promise<T>): Promise<T> {
    if (!docRef.current) throw new Error('Dokumen belum siap.')
    return fn(docRef.current)
  }

  async function onShare() {
    setBusy('share')
    setInfo(null)
    try {
      const png = await withNode(renderNodeToPng)
      const result = await shareSuratJalan(png, `${baseName}.png`)
      if (result === 'downloaded') {
        setInfo(
          'Browser tidak mendukung berbagi langsung — file diunduh, silakan bagikan secara manual.',
        )
      }
    } catch (e: unknown) {
      setInfo(e instanceof Error ? e.message : 'Gagal menyiapkan dokumen.')
    } finally {
      setBusy(null)
    }
  }

  async function onPdf() {
    setBusy('pdf')
    setInfo(null)
    try {
      const png = await withNode(renderNodeToPng)
      const pdf = await pngBlobToPdf(png)
      triggerDownload(pdf, `${baseName}.pdf`)
    } catch (e: unknown) {
      setInfo(e instanceof Error ? e.message : 'Gagal membuat PDF.')
    } finally {
      setBusy(null)
    }
  }

  async function onPng() {
    setBusy('png')
    setInfo(null)
    try {
      const png = await withNode(renderNodeToPng)
      triggerDownload(png, `${baseName}.png`)
    } catch (e: unknown) {
      setInfo(e instanceof Error ? e.message : 'Gagal membuat PNG.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <Card className="p-4 border-2 border-gold-300 bg-gold-50">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <div className="font-bold text-gray-900">Surat jalan siap.</div>
            <div className="text-sm text-gray-700 font-mono">{transfer.suratJalanNo}</div>
            {info && <div className="text-xs text-amber-700 mt-1">{info}</div>}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={onShare}
              loading={busy === 'share'}
              icon={<Share2 className="w-4 h-4" />}
            >
              Bagikan
            </Button>
            <Button
              variant="secondary"
              onClick={onPdf}
              loading={busy === 'pdf'}
              icon={<FileText className="w-4 h-4" />}
            >
              Unduh PDF
            </Button>
            <Button
              variant="secondary"
              onClick={onPng}
              loading={busy === 'png'}
              icon={<Download className="w-4 h-4" />}
            >
              Unduh PNG
            </Button>
            <Button
              variant="secondary"
              disabled={busy !== null}
              onClick={() => setShowPreview(true)}
              icon={<Eye className="w-4 h-4" />}
            >
              Lihat
            </Button>
          </div>
        </div>
      </Card>

      {/* Off-screen mount so html-to-image has a real DOM node to serialize. */}
      <div
        style={{ position: 'fixed', left: -9999, top: 0, pointerEvents: 'none' }}
        aria-hidden="true"
      >
        <div ref={docRef}>
          <IngredientSuratJalanDoc transfer={transfer} />
        </div>
      </div>

      <Modal
        open={showPreview}
        onClose={() => setShowPreview(false)}
        size="xl"
        title={`Pratinjau · ${transfer.suratJalanNo}`}
        padded={false}
      >
        <div
          style={{
            maxHeight: '70vh',
            overflow: 'auto',
            display: 'flex',
            justifyContent: 'center',
            padding: 16,
          }}
        >
          <div
            style={{
              transform: 'scale(0.75)',
              transformOrigin: 'top center',
              marginBottom: -200,
            }}
          >
            <IngredientSuratJalanDoc transfer={transfer} />
          </div>
        </div>
      </Modal>
    </>
  )
}
