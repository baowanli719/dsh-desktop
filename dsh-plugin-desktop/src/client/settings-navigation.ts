/** Public navigation seam supplied by the patched official settings shell. */

/** Immutable state consumed by the settings shell. */
export interface SettingsNavigationSnapshot {
  readonly requestId: number
  readonly sectionId: string | undefined
  readonly externalLauncher: boolean
}

/** Open settings at a section and let a richer sidebar launcher replace the default row. */
export interface SettingsNavigation {
  open(sectionId?: string): void
  claimExternalLauncher(): () => void
  getSnapshot(): SettingsNavigationSnapshot
  subscribe(listener: () => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Navigation service provided by ui-settings-general. */
    settingsNavigation: SettingsNavigation
  }
}

