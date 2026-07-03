/**
 * Image Uploader
 * Shared utility for extracting and uploading images in provider adapters
 */

import axios from 'axios'

const IMAGE_DOWNLOAD_TIMEOUT = 30000

/**
 * Result of an image upload
 */
export interface ImageUploadResult {
  url: string
  source_id?: string
  file_url?: string
  width?: number
  height?: number
  success: boolean
}

/**
 * Extract image_url entries from message content array
 */
export function extractImageUrls(messages: any[]): string[] {
  const urls: string[] = []

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue

    for (const part of msg.content) {
      if (part.type === 'image_url' && part.image_url?.url) {
        urls.push(part.image_url.url)
      }
    }
  }

  return urls
}

/**
 * Download image from URL (HTTP URL or base64 data URL)
 */
export async function downloadImage(imageUrl: string): Promise<{
  buffer: Buffer
  mimeType: string
  filename: string
}> {
  // Handle base64 data URLs
  if (imageUrl.startsWith('data:')) {
    const match = imageUrl.match(/^data:(image\/\w+);base64,(.+)$/)
    if (!match) {
      throw new Error('Invalid base64 image data URL')
    }
    const mimeType = match[1]
    const ext = mimeType.split('/')[1] || 'png'
    const buffer = Buffer.from(match[2], 'base64')
    return {
      buffer,
      mimeType,
      filename: `image.${ext}`,
    }
  }

  // Handle HTTP URLs
  const response = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    timeout: IMAGE_DOWNLOAD_TIMEOUT,
  })

  const mimeType = response.headers['content-type'] || 'image/png'
  const ext = mimeType.split('/')[1] || 'png'
  return {
    buffer: Buffer.from(response.data),
    mimeType,
    filename: `image.${ext}`,
  }
}

/**
 * Try to upload images for a provider adapter.
 * Gracefully handles failures - returns results with success=false for failed uploads.
 */
export async function uploadImages(
  imageUrls: string[],
  uploadFn: (imageUrl: string, buffer: Buffer, mimeType: string, filename: string) => Promise<ImageUploadResult>
): Promise<ImageUploadResult[]> {
  const results: ImageUploadResult[] = []

  for (const imageUrl of imageUrls) {
    try {
      const { buffer, mimeType, filename } = await downloadImage(imageUrl)
      const result = await uploadFn(imageUrl, buffer, mimeType, filename)
      results.push(result)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      console.error(`[ImageUpload] Failed to upload image: ${errorMessage}`)
      results.push({
        url: imageUrl,
        success: false,
      })
    }
  }

  return results
}
