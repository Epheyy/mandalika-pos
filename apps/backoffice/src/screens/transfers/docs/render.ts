// apps/backoffice/src/screens/transfers/docs/render.ts
//
// SP4 C2: HTML → PNG → PDF + share-sheet for the surat jalan.
//
// The pipeline takes a mounted <SuratJalanDoc/> DOM node (from C3's
// off-screen mount), serializes it to a PNG blob via html-to-image,
// optionally wraps the PNG into a single-page A4 PDF via jsPDF, and exposes
// a share helper that calls the Web Share API when supported, or falls
// back to a download anchor when not.
//
// TODO(test): no unit test attached yet. Backoffice has no Vitest harness
// today. The Web-Share-API fallback path needs visual verification at E1
// across Firefox desktop (no navigator.share → downloads PNG) and Chrome
// mobile (with navigator.share → opens OS share-sheet). Revisit if a
// jsdom harness is added.

import { toPng } from 'html-to-image'
import jsPDF from 'jspdf'

/**
 * Render an already-mounted DOM node to a PNG blob.
 * Uses pixelRatio: 2 for crisp letterheads on retina/mobile screens.
 */
export async function renderNodeToPng(node: HTMLElement): Promise<Blob> {
  const dataUrl = await toPng(node, {
    cacheBust: true,
    pixelRatio: 2,
    backgroundColor: '#ffffff',
  })
  const res = await fetch(dataUrl)
  return await res.blob()
}

/**
 * Wrap a PNG blob into a single-page A4 portrait PDF.
 * The SuratJalanDoc renders at 794×1123 px (A4 @ 96 dpi) so the image
 * fills the page edge-to-edge with the component's own internal padding
 * acting as the page margin.
 */
export async function pngBlobToPdf(png: Blob): Promise<Blob> {
  const dataUrl = await blobToDataUrl(png)
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
  // 210 × 297 mm = full A4. compression: 'FAST' keeps the bundle smaller
  // and rendering predictable; the source PNG is already 2× retina.
  pdf.addImage(dataUrl, 'PNG', 0, 0, 210, 297, undefined, 'FAST')
  return pdf.output('blob')
}

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(b)
  })
}

/**
 * Open the OS share-sheet with the PNG. Falls back to triggering a
 * download anchor when the Web Share API isn't supported (e.g. desktop
 * Firefox). Returns 'shared' on Web Share path, 'downloaded' on fallback.
 * Callers should show a toast on the 'downloaded' return.
 */
export async function shareSuratJalan(
  png: Blob,
  filename: string,
): Promise<'shared' | 'downloaded'> {
  const file = new File([png], filename, { type: 'image/png' })
  const nav = navigator as Navigator & {
    canShare?: (data: ShareData) => boolean
    share?: (data: ShareData) => Promise<void>
  }
  if (
    typeof nav.share === 'function' &&
    typeof nav.canShare === 'function' &&
    nav.canShare({ files: [file] })
  ) {
    try {
      await nav.share({ files: [file], title: filename })
    } catch {
      // User aborted the share-sheet — not an error. Don't fall back.
    }
    return 'shared'
  }
  triggerDownload(png, filename)
  return 'downloaded'
}

/** Force a file download via a transient anchor. */
export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
