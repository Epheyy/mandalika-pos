// apps/backoffice/src/screens/transfers/SuratJalanPanel.tsx
//
// SP4 C3: inline panel surfaced in TransferDetail when transfer.suratJalanNo
// is set (i.e. status ∈ {in_transit, completed}). Provides 4 actions:
//   • Bagikan  — OS share-sheet (PNG) via Web Share API; anchor-download fallback
//   • Unduh PDF — A4 PDF wrapping the PNG via jsPDF
//   • Unduh PNG — raw PNG from html-to-image
//   • Lihat    — scaled preview in a Modal
//
// The off-screen <SuratJalanDoc> is kept mounted via position:fixed;left:-9999px
// so html-to-image can traverse a real DOM node without display:none hiding it.
//
// TODO(test): no unit test attached yet. Backoffice has no Vitest harness.
// Visual verify at E1 (Firefox desktop = anchor fallback; Chrome mobile = share sheet).

import { useRef, useState } from 'react'
import { Share2, Download, FileText, Eye } from 'lucide-react'
import type { Transfer } from '@mandalika/api'
import { Button } from '../../ui/Button'
import { Modal } from '../../ui/Modal'
import { Card } from '../../ui/Card'
import { SuratJalanDoc } from './docs/SuratJalanDoc'
import {
  renderNodeToPng,
  pngBlobToPdf,
  shareSuratJalan,
  triggerDownload,
} from './docs/render'

interface SuratJalanPanelProps {
  transfer: Transfer
}

export function SuratJalanPanel({ transfer }: SuratJalanPanelProps) {
  const docRef = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState<null | 'share' | 'pdf' | 'png'>(null)
  const [showPreview, setShowPreview] = useState(false)
  const [info, setInfo] = useState<string | null>(null)

  // Only render once the server has assigned an SJ number (after Send).
  if (!transfer.suratJalanNo) return null

  const baseName = `suratjalan-${transfer.suratJalanNo}`

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

      {/* Off-screen mount so html-to-image has a real DOM node to serialize.
          position:fixed with left:-9999px keeps it off-flow without display:none
          (which would prevent measurement). pointer-events:none avoids any
          accidental interaction. */}
      <div
        style={{ position: 'fixed', left: -9999, top: 0, pointerEvents: 'none' }}
        aria-hidden="true"
      >
        <div ref={docRef}>
          <SuratJalanDoc transfer={transfer} />
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
            <SuratJalanDoc transfer={transfer} />
          </div>
        </div>
      </Modal>
    </>
  )
}
