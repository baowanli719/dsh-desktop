import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only service and SlotMap convergence for the Desktop settings section.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from './settings-navigation.ts'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { applyAdvancedShell } from './advanced-shell.ts'
import { startRendererBootReporter } from './boot-health.ts'
import { applyDesktopBrand } from './desktop-brand.tsx'
import { applyDesktopSettings } from './desktop-settings.ts'
import { installDesktopDirectoryPickerBridge } from './directory-picker.ts'
import { parseDesktopClientEnvironment } from './environment.ts'
import { installDesktopPermissionLabels } from './permission-labels.ts'
import { installSessionLogButtonVisibility } from './session-log-button.ts'
import { installDesktopTerminalDeliverables } from './terminal-deliverables.ts'
import { applyExtendedShell, applyFramedShell } from './extended-shell.ts'
import { createDesktopGsBrandApi } from './gs-brand-api.ts'
import { installDesktopComposerActions } from './composer-actions.ts'
import { desktopWindowService, provideDesktopWindow } from './window-service.ts'

declare global {
  /** Server-delivered brand headline consumed by the patched upstream hero. */
  // eslint-disable-next-line no-var
  var __GS_BRAND_HEADLINE__: string | undefined
  /** Server-delivered brand name reserved for upcoming brand surfaces. */
  // eslint-disable-next-line no-var
  var __GS_BRAND_NAME__: string | undefined
}

export { applyAdvancedShell } from './advanced-shell.ts'
export { applyDesktopBrand, DesktopBrandMark, DesktopBrandName } from './desktop-brand.tsx'
export { applyDesktopSettings } from './desktop-settings.ts'
export {
  attachComposerFiles,
  attachComposerImages,
  chooseComposerFiles,
  createDesktopComposerActionSource,
  DESKTOP_COMPOSER_ACTION_SOURCE,
  DESKTOP_SKILL_MENU_PREFIX,
  installDesktopComposerActions,
} from './composer-actions.ts'
export { applyExtendedShell, applyFramedShell } from './extended-shell.ts'
export {
  createDesktopSettingsApi,
  desktopSettingsPaths,
  parseDesktopActionAcceptance,
  parseDesktopRestartAcceptance,
  parseDesktopSettingsView,
} from './desktop-settings-api.ts'
export type {
  DesktopMarketProvider,
  DesktopMarketView,
  DesktopProfileView,
  DesktopRestartAcceptance,
  DesktopSettingsApi,
  DesktopSettingsView,
} from './desktop-settings-api.ts'
export { DesktopSettingsSection } from './DesktopSettingsSection.tsx'
export { DesktopTerminalSettingsAction } from './DesktopTerminalSettingsAction.tsx'
export type {
  DesktopTerminalSettingsActionInjected,
  DesktopTerminalSettingsActionProps,
} from './DesktopTerminalSettingsAction.tsx'
export type {
  DesktopNotificationSettings,
  DesktopSettingsSectionInjected,
  DesktopSettingsSectionProps,
  DesktopShellSettings,
} from './DesktopSettingsSection.tsx'
export {
  RENDERER_BOOT_REPORT_PATH,
  rendererBootReport,
  sendRendererBootReport,
  startRendererBootReporter,
} from './boot-health.ts'
export type { RendererBootLoader, RendererBootReport } from './boot-health.ts'
export { parseDesktopClientEnvironment } from './environment.ts'
export {
  applySessionLogButtonVisibility,
  installSessionLogButtonVisibility,
} from './session-log-button.ts'
export {
  DESKTOP_PERMISSION_DESCRIPTIONS,
  DESKTOP_PERMISSION_LABELS,
  installDesktopPermissionLabels,
} from './permission-labels.ts'
export type {
  DesktopClientEnvironment,
  DesktopClientMaterial,
  DesktopClientMode,
  DesktopClientPlatform,
} from './environment.ts'
export { desktopWindowService, provideDesktopWindow } from './window-service.ts'
export { DesktopWindowControls } from './DesktopWindowControls.tsx'
export type { DesktopWindowControlsProps } from './DesktopWindowControls.tsx'
export {
  createDesktopWindowControlsApi,
  desktopWindowControlsPaths,
  parseDesktopWindowState,
} from './window-controls-api.ts'
export {
  desktopTerminalDeliverablesAdapter,
  installDesktopTerminalDeliverables,
  reconcileTerminalDocxOutputs,
  terminalDocxOutputPaths,
} from './terminal-deliverables.ts'
export type {
  DesktopTerminalDeliverablesAdapter,
  ProducedPathLike,
} from './terminal-deliverables.ts'
export type {
  DesktopWindowControlsApi,
  DesktopWindowState,
} from './window-controls-api.ts'
export type {
  DesktopWindowDragRegion,
  DesktopWindowInsets,
  DesktopWindowService,
} from './contracts.ts'

/** Services required by Desktop settings and Desktop-owned presentations. */
export const inject = [
  'slots',
  'locale',
  'connection',
  'remote',
  'settingsScope',
  'sessions',
  'theme',
  'uiRenderer',
  'settingsNavigation',
  'conversation',
  'inputTriggers',
]

/** Register desktop-owned client surfaces for the current BrowserWindow mode. @param ctx - browser Cordis context. */
export function apply(ctx: ClientContext): void {
  const environment = parseDesktopClientEnvironment(window.location.search)
  if (!environment) return
  ctx.effect(
    installDesktopTerminalDeliverables,
    'dsh-plugin-desktop: terminal deliverable adapter',
  )
  // Publish the preset labels before the conversation plugin mounts; the
  // patched permission pickers read the global and fall back to their
  // English transforms when a value is absent from the map.
  installDesktopPermissionLabels()
  ctx.effect(
    () => installDesktopComposerActions(ctx),
    'dsh-plugin-desktop: composer plus menu actions',
  )
  ctx.effect(
    () => installSessionLogButtonVisibility(ctx),
    'dsh-plugin-desktop: session log button visibility',
  )
  // Publish the server-delivered brand before the conversation plugin mounts;
  // the patched hero reads the global and falls back to its locale dictionary.
  void createDesktopGsBrandApi().readBrand().then((brand) => {
    globalThis.__GS_BRAND_HEADLINE__ = brand.headline
    globalThis.__GS_BRAND_NAME__ = brand.name
  }).catch(() => {})
  applyDesktopBrand(ctx)
  ctx.effect(
    () => provideDesktopWindow(ctx, desktopWindowService(environment)),
    'dsh-plugin-desktop: native window geometry service',
  )
  const desktopSettings = applyDesktopSettings(ctx, environment)
  ctx.effect(
    () => startRendererBootReporter(ctx.loader),
    'dsh-plugin-desktop: renderer boot health report',
  )
  if (environment.platform === 'win32') {
    ctx.effect(
      () => installDesktopDirectoryPickerBridge(),
      'dsh-plugin-desktop: native directory picker bridge',
    )
  }
  if (environment.mode === 'advanced') applyAdvancedShell(ctx, environment)
  if (environment.mode === 'extended') applyExtendedShell(ctx, environment, desktopSettings)
  if (environment.platform !== 'linux' && environment.mode === 'compatibility') {
    applyFramedShell(ctx, environment, desktopSettings)
  }
}
