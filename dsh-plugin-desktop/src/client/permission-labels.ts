/**
 * Desktop-injected permission preset labels. The patched upstream permission
 * pickers (composer chip, /permission popup, settings default row) read
 * `globalThis.__GS_PERMISSION_LABELS__` keyed by preset value before falling
 * back to their English title-case transforms, so renaming a preset is a
 * one-line change here — the patch itself carries no copy.
 */

declare global {
  /** Label map consumed by the patched upstream permission pickers. */
  // eslint-disable-next-line no-var
  var __GS_PERMISSION_LABELS__: Record<string, string> | undefined
  /** Rich copy consumed by the desktop composer permission menu. */
  // eslint-disable-next-line no-var
  var __GS_PERMISSION_DESCRIPTIONS__: Record<string, string> | undefined
}

/** Chinese product names for the desktop permission presets, keyed by preset value. */
export const DESKTOP_PERMISSION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'read-only': '只读',
  'workspace-write': '默认',
  'danger-full-access': '全自动',
})

/** Short explanations shown below each preset in the composer menu. */
export const DESKTOP_PERMISSION_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  'read-only': '仅可读取文件，写入及受限操作会询问',
  'workspace-write': '可读写工作区，关键操作会询问',
  'danger-full-access': '所有操作无需确认直接执行',
})

/**
 * Publish preset labels where the patched upstream bundles read them.
 * @param labels - label map keyed by preset value; defaults to the desktop Chinese names.
 */
export function installDesktopPermissionLabels(
  labels: Readonly<Record<string, string>> = DESKTOP_PERMISSION_LABELS,
  descriptions: Readonly<Record<string, string>> = DESKTOP_PERMISSION_DESCRIPTIONS,
): void {
  globalThis.__GS_PERMISSION_LABELS__ = { ...labels }
  globalThis.__GS_PERMISSION_DESCRIPTIONS__ = { ...descriptions }
}
