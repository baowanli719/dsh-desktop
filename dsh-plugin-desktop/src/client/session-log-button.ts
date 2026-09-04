/**
 * Show or hide the upstream session-log export action in the session header.
 * The upstream action carries a Desktop-patched stable data attribute, so the
 * rule targets that contribution directly without depending on a hashed class
 * or an implementation-detail slot wrapper. Visibility follows the
 * dsh-desktop sessionLogButton setting (default hidden) and flips live through
 * the settings mirror — no restart.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import { DESKTOP_SHELL_SETTINGS_NAMESPACE } from './desktop-settings.ts'
import type { DesktopShellSettings } from './DesktopSettingsSection.tsx'

const STYLE_ID = 'dsh-desktop-session-log-button'
const VISIBILITY_ATTRIBUTE = 'dshDesktopSessionLogButton'

const CSS = `
body[data-dsh-desktop-session-log-button="hidden"] [data-dsh-session-log-download="action"] {
  display: none !important;
}
`

/**
 * Mirror the setting onto a body attribute the hiding rule keys on.
 * @param settings - bound dsh-desktop namespace scope.
 * @returns disposer removing the subscription, the attribute, and the rule.
 */
export function applySessionLogButtonVisibility(
  settings: Pick<SettingsScope<DesktopShellSettings>, 'getSnapshot' | 'subscribe'>,
): () => void {
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.dataset.plugin = 'dsh-plugin-desktop'
  style.dataset.pluginCss = 'dsh-plugin-desktop/session-log-button'
  style.textContent = CSS
  document.head.appendChild(style)
  const sync = (): void => {
    // Unset or unreadable values take the schema default: hidden.
    const shown = settings.getSnapshot().value?.sessionLogButton ?? false
    if (shown) delete document.body.dataset[VISIBILITY_ATTRIBUTE]
    else document.body.dataset[VISIBILITY_ATTRIBUTE] = 'hidden'
  }
  sync()
  const unsubscribe = settings.subscribe(sync)
  return () => {
    unsubscribe()
    style.remove()
    delete document.body.dataset[VISIBILITY_ATTRIBUTE]
  }
}

/**
 * Bind the dsh-desktop namespace and install the visibility mirror.
 * @param ctx - browser Cordis context carrying the settings scope service.
 * @returns disposer for the owning ctx.effect.
 */
export function installSessionLogButtonVisibility(ctx: ClientContext): () => void {
  const settings = ctx.settingsScope.bind<DesktopShellSettings>({
    namespace: DESKTOP_SHELL_SETTINGS_NAMESPACE,
  })
  return applySessionLogButtonVisibility(settings)
}
