// ============================================
// ☁️ Cloudinary image upload utility
// ============================================

const CLOUD_NAME = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME
const UPLOAD_PRESET = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET

export interface UploadResult {
  url: string
  publicId: string
}

/**
 * Upload an image file to Cloudinary
 * Returns the public URL and the public ID (for deletion later)
 */
export async function uploadImage(file: File): Promise<UploadResult> {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('upload_preset', UPLOAD_PRESET)
  formData.append('folder', 'mandalika-pos/products')

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`,
    {
      method: 'POST',
      body: formData,
    }
  )

  if (!response.ok) {
    throw new Error('Image upload failed. Please try again.')
  }

  const data = await response.json()

  return {
    url: data.secure_url,   // The public HTTPS URL — use this in your app
    publicId: data.public_id // The ID — use this if you want to delete it later
  }
}

/**
 * Generate an optimized thumbnail URL from a Cloudinary URL
 * This resizes the image on-the-fly without storing a new copy
 */
export function getThumbnailUrl(url: string, width = 400, height = 400): string {
  if (!url || !url.includes('cloudinary.com')) return url
  
  // Insert transformation parameters into the URL
  return url.replace(
    '/upload/',
    `/upload/w_${width},h_${height},c_fill,q_auto,f_auto/`
  )
}