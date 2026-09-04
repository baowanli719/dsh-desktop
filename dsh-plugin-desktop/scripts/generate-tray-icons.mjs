/** Generate native tray bitmaps from the repository-owned brand mark. */

import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const buildRoot = join(packageRoot, 'build')
const sourcePath = join(buildRoot, 'brand', 'logo.png')

/** Tray accent color sampled from the brand mark's blue wave. */
const BRAND_BLUE = '#3D77DC'

const variants = [
  ['tray-iconTemplate.png', '#000000', 16],
  ['tray-iconTemplate@2x.png', '#000000', 32],
  ['tray-icon-blue.png', BRAND_BLUE, 16],
  ['tray-icon-blue@1.25x.png', BRAND_BLUE, 20],
  ['tray-icon-blue@1.5x.png', BRAND_BLUE, 24],
  ['tray-icon-blue@2x.png', BRAND_BLUE, 32],
]

/**
 * Trim the brand mark to its content, center it on a square canvas, and
 * recolor its silhouette.
 * @param {string} color - silhouette fill color.
 * @param {number} size - square output edge in pixels.
 * @returns {Promise<Buffer>} encoded PNG.
 */
async function silhouette(color, size) {
  const mark = await sharp(sourcePath)
    .trim({ threshold: 10 })
    .resize({ width: size, height: size, fit: 'inside', kernel: sharp.kernel.lanczos3 })
    .toBuffer()
  const alpha = await sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: mark, gravity: 'center' }])
    .extractChannel('alpha')
    .png()
    .toBuffer()
  return sharp({
    create: { width: size, height: size, channels: 3, background: color },
  })
    .joinChannel(alpha)
    .png({ compressionLevel: 9 })
    .toBuffer()
}

await Promise.all(variants.map(async ([filename, color, size]) => {
  await writeFile(join(buildRoot, filename), await silhouette(color, size))
}))
