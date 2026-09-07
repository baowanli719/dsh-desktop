/** Shared application icon path for Desktop-owned windows. */

import { fileURLToPath } from 'node:url'

/**
 * Packaged application icon for one platform. Auxiliary windows receive the
 * path directly — Electron decodes it at window construction — so pre-Host
 * windows (login, setup wizard, recovery) carry the product logo instead of
 * the Electron fallback that development launches would otherwise show.
 */
export function desktopAppIconPath(platform: NodeJS.Platform = process.platform): string {
  const filename = platform === 'darwin' ? 'app-icon-mac.png' : 'app-icon.png'
  return fileURLToPath(new URL(`../build/${filename}`, import.meta.url))
}
