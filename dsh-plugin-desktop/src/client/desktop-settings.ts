/** Official Settings Slot registration for Desktop-owned preferences. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import { DesktopAboutSection } from './DesktopAboutSection.tsx'
import { DesktopAccountMenu } from './DesktopAccountMenu.tsx'
import { DesktopSettingsSection, type DesktopNotificationSettings, type DesktopShellSettings } from './DesktopSettingsSection.tsx'
import { DesktopSkillsSection } from './DesktopSkillsSection.tsx'
import { DesktopTerminalSettingsAction } from './DesktopTerminalSettingsAction.tsx'
import { createDesktopSettingsApi } from './desktop-settings-api.ts'
import { createDesktopGsAccountApi } from './gs-account-api.ts'
import { createDesktopGsBrandApi } from './gs-brand-api.ts'
import { createDesktopGsSkillsApi } from './gs-skills-api.ts'
import { en, zh, type DesktopSettingsLocaleKey } from './desktop-settings-locales.ts'
import { installDesktopSettingsStyles } from './desktop-settings-styles.ts'
import { installDesktopAccountMenuStyles } from './account-menu-styles.ts'
import type { DesktopClientEnvironment } from './environment.ts'
import type {} from './settings-navigation.ts'

/** Locale namespace owned by the Desktop settings page. */
export const DESKTOP_SETTINGS_LOCALE_NAMESPACE = 'desktop.settings'

/** Host settings namespaces bound through the standard client settings service. */
export const DESKTOP_SHELL_SETTINGS_NAMESPACE = 'dsh-desktop'
export const DESKTOP_NOTIFICATIONS_SETTINGS_NAMESPACE = 'dsh-desktop-notifications'

/** Shared client controls consumed by settings and Desktop-owned window chrome. */
export interface DesktopSettingsClientControl {
  readonly api: ReturnType<typeof createDesktopSettingsApi>
  setMode(mode: DesktopShellSettings['mode']): Promise<void>
}

/**
 * Persist a native mode choice without leaving browser access in a mode the
 * marker-free client cannot render. Custom modes withdraw browser and LAN
 * access in ordered writes; the Host compares only effective generation state.
 */
export async function persistDesktopModeSelection(
  desktopSettings: Pick<SettingsScope<DesktopShellSettings>, 'set'>,
  mode: DesktopShellSettings['mode'],
): Promise<void> {
  if (mode === 'compatibility') {
    await desktopSettings.set('mode', mode)
    return
  }
  // The titlebar is interactive before the settings mirror necessarily reaches
  // ready. Always withdraw both browser capabilities for a custom mode instead
  // of treating an unavailable or stale snapshot as browser access being off.
  // Withdraw the listener first so every intermediate persisted state remains
  // valid while compatibility mode is still selected.
  await desktopSettings.set('networkExposure', 'loopback')
  await desktopSettings.set('openBrowser', false)
  await desktopSettings.set('mode', mode)
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Desktop-only settings page copy. */
    'desktop.settings': DesktopSettingsLocaleKey
  }
}

/** Register the Desktop pages in the settings.section list slot. */
export function applyDesktopSettings(
  ctx: ClientContext,
  environment: DesktopClientEnvironment,
): DesktopSettingsClientControl {
  const desktopSettings = ctx.settingsScope.bind<DesktopShellSettings>({
    namespace: DESKTOP_SHELL_SETTINGS_NAMESPACE,
  })
  const notificationSettings = ctx.settingsScope.bind<DesktopNotificationSettings>({
    namespace: DESKTOP_NOTIFICATIONS_SETTINGS_NAMESPACE,
  })
  const api = createDesktopSettingsApi()
  const gsAccount = createDesktopGsAccountApi()
  const gsBrand = createDesktopGsBrandApi()
  const gsSkills = createDesktopGsSkillsApi()
  const t = ctx.locale.bind(DESKTOP_SETTINGS_LOCALE_NAMESPACE)
  const setMode = async (mode: DesktopShellSettings['mode']): Promise<void> => {
    await persistDesktopModeSelection(desktopSettings, mode)
  }

  ctx.effect(
    () => ctx.locale.register(DESKTOP_SETTINGS_LOCALE_NAMESPACE, { zh, en }),
    'dsh-plugin-desktop: settings dictionaries',
  )
  ctx.effect(
    () => installDesktopSettingsStyles(),
    'dsh-plugin-desktop: settings styles',
  )
  ctx.effect(
    () => installDesktopAccountMenuStyles(),
    'dsh-plugin-desktop: account menu styles',
  )
  ctx.effect(
    () => ctx.settingsNavigation.claimExternalLauncher(),
    'dsh-plugin-desktop: replace default settings launcher',
  )
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'desktop',
    order: 100,
    label: () => t('nav'),
    locale: DESKTOP_SETTINGS_LOCALE_NAMESPACE,
    inject: () => ({
      api,
      gsAccount,
      gsBrand,
      platform: environment.platform,
      initialMode: environment.mode,
      micaSupported: environment.micaSupported,
      setMode,
      desktopSettings,
      notificationSettings,
    }),
  }, DesktopSettingsSection))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'desktop-skills',
    order: 110,
    label: () => t('skillsNav'),
    locale: DESKTOP_SETTINGS_LOCALE_NAMESPACE,
    inject: () => ({ gsSkills, gsBrand }),
  }, DesktopSkillsSection))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'desktop-about',
    order: 120,
    label: () => t('aboutNav'),
    locale: DESKTOP_SETTINGS_LOCALE_NAMESPACE,
    inject: () => ({ api, version: environment.version }),
  }, DesktopAboutSection))
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'desktop-account-menu',
    order: 1000,
    locale: DESKTOP_SETTINGS_LOCALE_NAMESPACE,
    inject: () => ({
      gsAccount,
      settingsNavigation: ctx.settingsNavigation,
      version: environment.version,
    }),
  }, DesktopAccountMenu))
  ctx.slots.inject('settings.action', () => ctx.slots.register({
    name: 'settings.action',
    id: 'open-desktop-terminal',
    order: 1,
    locale: DESKTOP_SETTINGS_LOCALE_NAMESPACE,
    inject: () => ({ api }),
  }, DesktopTerminalSettingsAction))

  return Object.freeze({
    api,
    setMode,
  })
}
