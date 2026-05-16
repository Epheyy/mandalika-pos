/** Server-signed Cloudinary upload (plan §8). Secret never touches the client. */

import type { UploadSignature } from '@mandalika/api'
import { api } from '../api'

export async function uploadImage(
  file: File,
  folder = 'mandalika-pos/products',
): Promise<string> {
  const sig: UploadSignature = await api.signUpload(folder)
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

export function getThumbnailUrl(url: string, width = 400, height = 400): string {
  if (!url || !url.includes('cloudinary.com')) return url
  return url.replace(
    '/upload/',
    `/upload/w_${width},h_${height},c_fill,q_auto,f_auto/`,
  )
}
