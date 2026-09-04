/** Desktop About and version section. */

import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopSettingsApi } from './desktop-settings-api.ts'

export interface DesktopAboutSectionInjected {
  readonly api: Pick<DesktopSettingsApi, 'checkForUpdates'>
  readonly version: string
}

export type DesktopAboutSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'desktop.settings'>
  & InjectFace<DesktopAboutSectionInjected>

/** Show installed version and the native update check action. */
export function DesktopAboutSection({ t, api, version }: DesktopAboutSectionProps) {
  const [checking, setChecking] = useState(false)
  const [failed, setFailed] = useState(false)

  const check = async (): Promise<void> => {
    if (checking) return
    setChecking(true)
    setFailed(false)
    try {
      await api.checkForUpdates()
    } catch {
      setFailed(true)
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="dshDesktopSettings">
      <header className="dshDesktopSettingsHeader">
        <h2 id="dsh-desktop-about-title">{t('aboutTitle')}</h2>
        <p>{t('aboutIntro')}</p>
      </header>
      <section className="dshDesktopSettingsGroup" aria-labelledby="dsh-desktop-about-version-title">
        <h3 id="dsh-desktop-about-version-title">{t('aboutVersion')}</h3>
        <div className="dshDesktopSettingsToggleRow">
          <span className="dshDesktopSettingsChoiceCopy">
            <span className="dshDesktopSettingsChoiceTitle">gs-worker</span>
            <span className="dshDesktopSettingsChoiceBody">v{version}</span>
          </span>
          <button
            type="button"
            className="dshDesktopSettingsButton"
            disabled={checking}
            onClick={() => { void check() }}
          >
            {checking ? t('checkingForUpdates') : t('checkForUpdates')}
          </button>
        </div>
        {failed && <p className="dshDesktopSettingsError" role="alert">{t('checkForUpdatesError')}</p>}
      </section>
    </div>
  )
}

