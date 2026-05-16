/**
 * Server-signed Cloudinary upload (plan §8).
 * Mainly used by Backoffice (Phase D); included here for parity.
 */

import { api } from '../api'
import type { components } from '@mandalika/api'

type UploadSignature = components['schemas']['UploadSignature']

export async function uploadImage(
  file: File,
  folder?: string,
): Promise<string> {
  const r = await api.request<{ data: UploadSignature }>(
    'POST',
    '/api/v1/uploads/sign',
    { folder },
  )
  const sig = r.data
  const form = new FormData()
  form.append('file', file)
  form.append('api_key', sig.apiKey)
  form.append('timestamp', String(sig.timestamp))
  form.append('signature', sig.signature)
  if (sig.folder) form.append('folder', sig.folder)

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${sig.cloudName}/image/upload`,
    { method: 'POST', body: form },
  )
  if (!res.ok) throw new Error('Cloudinary upload failed')
  const json = (await res.json()) as { secure_url: string }
  return json.secure_url
}
