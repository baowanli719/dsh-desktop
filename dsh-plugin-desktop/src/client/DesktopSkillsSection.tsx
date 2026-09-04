/** Desktop-owned skills settings section registered into the official Settings shell. */

import { useCallback, useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopGsSkillsApi } from './gs-skills-api.ts'
import type { DesktopGsBrandApi } from './gs-brand-api.ts'
import type { GsBrandView, GsSkillsView } from '../server/gs-contract.ts'
import { GS_BRAND_DEFAULT } from '../brand.ts'

/** Registration-side business face for the Desktop skills section. */
export interface DesktopSkillsSectionInjected {
  readonly gsSkills: DesktopGsSkillsApi
  readonly gsBrand: DesktopGsBrandApi
}

/** Renderer-composed props for the official skills section entry. */
export type DesktopSkillsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'desktop.settings'>
  & InjectFace<DesktopSkillsSectionInjected>

/** Render the Desktop skills page. */
export function DesktopSkillsSection({
  t: translate,
  gsSkills,
  gsBrand,
}: DesktopSkillsSectionProps) {
  const [skillsView, setSkillsView] = useState<GsSkillsView>()
  const [skillsFailed, setSkillsFailed] = useState(false)
  const [brand, setBrand] = useState<GsBrandView>()

  useEffect(() => {
    let cancelled = false
    gsBrand.readBrand()
      .then((value) => { if (!cancelled) setBrand(value) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [gsBrand])

  // Dictionary strings with a {brand} placeholder resolve against the
  // server-delivered brand; before the fetch lands the built-in default speaks.
  const t = useCallback<DesktopSkillsSectionProps['t']>(
    key => translate(key).replaceAll('{brand}', brand?.name ?? GS_BRAND_DEFAULT.name),
    [translate, brand],
  )

  useEffect(() => {
    let cancelled = false
    gsSkills.readSkills()
      .then((value) => { if (!cancelled) setSkillsView(value) })
      .catch(() => { if (!cancelled) setSkillsFailed(true) })
    return () => { cancelled = true }
  }, [gsSkills])

  return (
    <div className="dshDesktopSettings">
      <header className="dshDesktopSettingsHeader">
        <h2 id="dsh-desktop-skills-title">{t('skillsTitle')}</h2>
        <p>{t('skillsIntro')}</p>
      </header>

      <section className="dshDesktopSettingsGroup" aria-labelledby="dsh-desktop-skills-title">
        {skillsFailed && skillsView === undefined && (
          <p className="dshDesktopSettingsError" role="alert">{t('skillsUnavailable')}</p>
        )}
        {!skillsFailed && skillsView === undefined && (
          <p className="dshDesktopSettingsHint">{t('skillsLoading')}</p>
        )}
        {skillsView?.status === 'signed-out' && (
          <p className="dshDesktopSettingsNotice" role="status">{t('skillsSignedOut')}</p>
        )}
        {skillsView?.status === 'error' && (
          <p className="dshDesktopSettingsNotice" role="status">{t('skillsError')}</p>
        )}
        {skillsView !== undefined && skillsView.status !== 'signed-out' && skillsView.status !== 'error'
          && skillsView.skills.length === 0 && (
          <p className="dshDesktopSettingsHint">
            {skillsView.masterOff === true
              ? t('skillsMasterOff')
              : (skillsView.switchedOff ?? 0) > 0
                ? t('skillsAllSwitchedOff').replace('{count}', String(skillsView.switchedOff))
                : t('skillsEmpty')}
          </p>
        )}
        {skillsView !== undefined && skillsView.skills.length > 0 && (
          <div className="dshDesktopSettingsList">
            {skillsView.skills.map(skill => (
              <div key={skill.name} className="dshDesktopSettingsChoice">
                <span className="dshDesktopSettingsChoiceCopy">
                  <span className="dshDesktopSettingsChoiceTitle">
                    {skill.displayName ?? skill.name}
                    {skill.version !== undefined && <span className="dshDesktopSettingsBadge">{skill.version}</span>}
                  </span>
                  <span className="dshDesktopSettingsChoiceBody">{skill.description}</span>
                </span>
              </div>
            ))}
          </div>
        )}
        {skillsView !== undefined && skillsView.skills.length > 0 && (skillsView.switchedOff ?? 0) > 0 && (
          <p className="dshDesktopSettingsHint">
            {t('skillsPartiallySwitchedOff').replace('{count}', String(skillsView.switchedOff))}
          </p>
        )}
        {skillsView?.syncedAt !== undefined && (
          <p className="dshDesktopSettingsHint">
            {t('skillsSyncedAt')}: {new Date(skillsView.syncedAt).toLocaleString()}
          </p>
        )}
      </section>
    </div>
  )
}
