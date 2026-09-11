/**
 * Tune the gap between the session header utilities and the corner control.
 * The upstream stylesheet fixes the corner margin at 8px and injects its module
 * styles late, so the rule overrides it through a higher-specificity body
 * attribute selector rather than source order. The gap follows the dsh-desktop
 * headerCornerGap setting (default 16px) and flips live through the settings
 * mirror — no restart.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import { DESKTOP_SHELL_SETTINGS_NAMESPACE } from './desktop-settings.ts'
import type { DesktopShellSettings } from './DesktopSettingsSection.tsx'

const STYLE_ID = 'dsh-desktop-header-corner-gap'
const GAP_ATTRIBUTE = 'dshDesktopHeaderCornerGap'
const GAP_VARIABLE = '--dsh-desktop-header-corner-gap'
const DEFAULT_GAP = 16

const CSS = `
body[data-dsh-desktop-header-corner-gap] [data-conversation-header-corner] {
  margin-left: var(--dsh-desktop-header-corner-gap, 16px) !important;
}
`

/**
 * Mirror the setting onto a body attribute and a CSS variable the gap rule keys on.
 * @param settings - bound dsh-desktop namespace scope.
 * @returns disposer removing the subscription, the attribute, and the rule.
 */
export function applyHeaderCornerGap(
  settings: Pick<SettingsScope<DesktopShellSettings>, 'getSnapshot' | 'subscribe'>,
): () => void {
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.dataset.plugin = 'dsh-plugin-desktop'
  style.dataset.pluginCss = 'dsh-plugin-desktop/header-corner-gap'
  style.textContent = CSS
  document.head.appendChild(style)
  const sync = (): void => {
    // Unset or unreadable values take the schema default: 16px.
    const gap = settings.getSnapshot().value?.headerCornerGap ?? DEFAULT_GAP
    document.body.dataset[GAP_ATTRIBUTE] = String(gap)
    document.body.style.setProperty(GAP_VARIABLE, `${gap}px`)
  }
  sync()
  const unsubscribe = settings.subscribe(sync)
  return () => {
    unsubscribe()
    style.remove()
    delete document.body.dataset[GAP_ATTRIBUTE]
    document.body.style.removeProperty(GAP_VARIABLE)
  }
}

/**
 * Bind the dsh-desktop namespace and install the gap mirror.
 * @param ctx - browser Cordis context carrying the settings scope service.
 * @returns disposer for the owning ctx.effect.
 */
export function installHeaderCornerGap(ctx: ClientContext): () => void {
  const settings = ctx.settingsScope.bind<DesktopShellSettings>({
    namespace: DESKTOP_SHELL_SETTINGS_NAMESPACE,
  })
  return applyHeaderCornerGap(settings)
}
