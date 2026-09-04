/** Renderer-drawn Windows caption buttons for the independent Desktop frame. */

import type { DesktopSettingsLocaleKey } from './desktop-settings-locales.ts'

export interface DesktopWindowControlsProps {
  /** Current maximized state, driving the maximize/restore icon swap. */
  readonly maximized: boolean
  readonly onMinimize: () => void
  readonly onToggleMaximize: () => void
  readonly onClose: () => void
  readonly t: (key: DesktopSettingsLocaleKey) => string
}

function MinimizeIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <path d="M1 5.5h8" fill="none" stroke="currentColor" />
    </svg>
  )
}

function MaximizeIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <rect x="1.5" y="1.5" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" />
    </svg>
  )
}

function RestoreIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <path d="M3.5 3.5v-1a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1" fill="none" stroke="currentColor" />
      <rect x="1.5" y="3.5" width="5" height="5" rx="1" fill="none" stroke="currentColor" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <path d="m1.5 1.5 7 7m0-7-7 7" fill="none" stroke="currentColor" />
    </svg>
  )
}

/** Frameless-window minimize / maximize-restore / close buttons (win32 only). */
export function DesktopWindowControls({
  maximized,
  onMinimize,
  onToggleMaximize,
  onClose,
  t,
}: DesktopWindowControlsProps) {
  return (
    <div className="dshDesktopWindowControls">
      <button
        type="button"
        className="dshDesktopWindowControlsButton"
        aria-label={t('minimizeWindow')}
        onClick={onMinimize}
      >
        <MinimizeIcon />
      </button>
      <button
        type="button"
        className="dshDesktopWindowControlsButton"
        aria-label={t(maximized ? 'restoreWindow' : 'maximizeWindow')}
        onClick={onToggleMaximize}
      >
        {maximized ? <RestoreIcon /> : <MaximizeIcon />}
      </button>
      <button
        type="button"
        className="dshDesktopWindowControlsButton dshDesktopWindowControlsClose"
        aria-label={t('closeWindow')}
        onClick={onClose}
      >
        <CloseIcon />
      </button>
    </div>
  )
}
