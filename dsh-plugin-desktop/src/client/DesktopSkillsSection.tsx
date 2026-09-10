/** Desktop-owned skills settings section registered into the official Settings shell. */

import { memo, useCallback, useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopGsSkillsApi } from './gs-skills-api.ts'
import type { DesktopGsBrandApi } from './gs-brand-api.ts'
import type { GsBrandView, GsSkillsView, GsSkillViewItem } from '../server/gs-contract.ts'
import { GS_BRAND_DEFAULT } from '../brand.ts'

/** Registration-side business face for the Desktop skills section. */
export interface DesktopSkillsSectionInjected {
  readonly gsSkills: DesktopGsSkillsApi
  readonly gsBrand: DesktopGsBrandApi
}

/** Locale key of one execution-kind badge. */
const EXECUTION_BADGE_KEYS = {
  'desktop': 'skillsExecDesktop',
  'server-data-query': 'skillsExecDataQuery',
  'server-mcp': 'skillsExecServerMcp',
} as const

/** Locale key of one unavailability cause. */
const UNAVAILABLE_REASON_KEYS: Record<string, 'skillsUnavailableRuntime' | 'skillsUnavailableDefinition'> = {
  'runtime-unsupported': 'skillsUnavailableRuntime',
  'definition-error': 'skillsUnavailableDefinition',
}

/** Renderer-composed props for the official skills section entry. */
export type DesktopSkillsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'desktop.settings'>
  & InjectFace<DesktopSkillsSectionInjected>

/** One server-delivered skill row with its activation switch. */
export interface DesktopSkillToggleRowProps {
  readonly skill: GsSkillViewItem
  /** A save for this row is in flight; only its own switch locks. */
  readonly pending: boolean
  readonly disabled: boolean
  readonly t: DesktopSkillsSectionProps['t']
  readonly onToggle: (skill: GsSkillViewItem, enabled: boolean) => void
}

/**
 * Render one skill row. Memoized: the skills view updates immutably per
 * toggle, so rows whose skill object is untouched never re-render.
 */
export const DesktopSkillToggleRow = memo(function DesktopSkillToggleRow({
  skill,
  pending,
  disabled,
  t,
  onToggle,
}: DesktopSkillToggleRowProps) {
  const checked = skill.enabled !== false
  return (
    <div className="dshDesktopSettingsChoice">
      <span className="dshDesktopSettingsChoiceCopy">
        <span className="dshDesktopSettingsChoiceTitle">
          {skill.displayName ?? skill.name}
          {skill.version !== undefined && <span className="dshDesktopSettingsBadge">{skill.version}</span>}
          {skill.execution !== undefined && (
            <span className="dshDesktopSettingsBadge">{t(EXECUTION_BADGE_KEYS[skill.execution])}</span>
          )}
        </span>
        <span className="dshDesktopSettingsChoiceBody">{skill.description}</span>
        {skill.available === false && (
          <span className="dshDesktopSettingsChoiceBody">
            {t(UNAVAILABLE_REASON_KEYS[skill.unavailableReason ?? ''] ?? 'skillsUnavailableRuntime')}
          </span>
        )}
      </span>
      <button
        type="button"
        role="switch"
        className="dshDesktopSettingsToggle"
        aria-checked={checked}
        aria-label={skill.displayName ?? skill.name}
        disabled={pending || disabled}
        onClick={() => { onToggle(skill, !checked) }}
      >
        <span className="dshDesktopSettingsToggleKnob" aria-hidden="true" />
      </button>
    </div>
  )
})

/** Render the Desktop skills page. */
export function DesktopSkillsSection({
  t: translate,
  gsSkills,
  gsBrand,
}: DesktopSkillsSectionProps) {
  const [skillsView, setSkillsView] = useState<GsSkillsView>()
  const [skillsFailed, setSkillsFailed] = useState(false)
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [saveFailed, setSaveFailed] = useState(false)
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

  // Flip the one row optimistically so a save never repaints or locks the
  // rest of the list; a failure restores the original row object and shows
  // the error banner.
  const toggleSkill = useCallback((skill: GsSkillViewItem, enabled: boolean) => {
    setSaveFailed(false)
    setPending(current => new Set(current).add(skill.name))
    setSkillsView(view => view === undefined ? view : {
      ...view,
      skills: view.skills.map(item => item.name === skill.name ? { ...item, enabled } : item),
    })
    void gsSkills.setEnabled(skill.name, enabled)
      .catch(() => {
        setSkillsView(view => view === undefined ? view : {
          ...view,
          skills: view.skills.map(item => item.name === skill.name ? skill : item),
        })
        setSaveFailed(true)
      })
      .finally(() => {
        setPending((current) => {
          const next = new Set(current)
          next.delete(skill.name)
          return next
        })
      })
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
        {saveFailed && (
          <p className="dshDesktopSettingsError" role="alert">{t('skillsSaveFailed')}</p>
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
        {skillsView !== undefined && skillsView.execution?.supported === false && (
          <p className="dshDesktopSettingsHint">{t('skillsExecutionUnsupported')}</p>
        )}
        {skillsView !== undefined && skillsView.skills.length > 0 && (
          <div className="dshDesktopSettingsList">
            {skillsView.skills.map(skill => (
              <DesktopSkillToggleRow
                key={skill.name}
                skill={skill}
                pending={pending.has(skill.name)}
                disabled={skillsView.status !== 'ok' || skillsView.masterOff === true || skill.available === false}
                t={t}
                onToggle={toggleSkill}
              />
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
