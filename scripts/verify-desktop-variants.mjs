import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const stableRoot = join(root, 'dsh-plugin-desktop', 'src')
const betaRoot = join(root, 'dsh-plugin-desktop-beta', 'src')
// PR #868's isolated compatibility chrome is beta-only. Stable retains the
// single-document frame; both variants retain renderer crash recovery (#869).
const betaOnlyPaths = new Set([
  // Default Beta Host process experiment remains Beta-only until validated.
  'host-bootstrap.ts',
  'host-launch-environment.ts',
  'host-process.ts',
  'host-process-entry.ts',
  'host-rpc.ts',
  'host-runtime-bridge.ts',
  'client/DesktopFrameTitlebarView.tsx',
  'compatibility-chrome-contract.ts',
  'compatibility-preload.ts',
  'compatibility-shell.ts',
  'native-ui/compatibility-chrome.html',
  'native-ui/compatibility-chrome/main.tsx',
  'native-ui/compatibility-chrome/overlay.ts',
  'native-ui/compatibility-chrome/style.css',
])
const allowedDifferences = new Set([
  // The stable package is the gs-worker office Agent; Beta remains the stock
  // upstream DSH Desktop product. These files implement that product boundary.
  'app-icon.ts',
  'brand.ts',
  'index.ts',
  'notifications.ts',
  'client/DesktopAboutSection.tsx',
  'client/DesktopAccountMenu.tsx',
  'client/DesktopSkillsSection.tsx',
  'client/DesktopWindowControls.tsx',
  'client/ExtendedTitlebar.tsx',
  'client/account-menu-styles.ts',
  'client/brand-logo.ts',
  'client/composer-actions.ts',
  'client/desktop-brand.tsx',
  'client/desktop-settings-locales.ts',
  'client/directory-picker.ts',
  'client/extended-shell.ts',
  'client/extended-styles.ts',
  'client/gs-account-api.ts',
  'client/gs-brand-api.ts',
  'client/gs-skills-api.ts',
  'client/permission-labels.ts',
  'client/session-log-button.ts',
  'client/settings-navigation.ts',
  'client/styles.ts',
  'client/terminal-deliverables.ts',
  'client/window-controls-api.ts',
  'desktop-boot-recovery.ts',
  'desktop-settings-route.ts',
  'desktop-window-controls-route.ts',
  'electron-runtime.ts',
  'electron-shell-generation.ts',
  'login-contract.ts',
  'login-copy.ts',
  'login-window.ts',
  'local-window-policy.ts',
  'mcp-vision-server.ts',
  'native-dialog-copy.ts',
  'native-ui/desktop-dialog.html',
  'native-ui/login.html',
  'native-ui/login/App.tsx',
  'native-ui/login/bridge.ts',
  'native-ui/login/logic.ts',
  'native-ui/login/main.tsx',
  'native-ui/recovery.html',
  'native-ui/setup-wizard.html',
  'native-ui/shared/theme.css',
  'prompt-language.ts',
  'recovery-copy.ts',
  'runtime.ts',
  'server-skill-provider.ts',
  'server-skill-tools.ts',
  'server/gs-auth.ts',
  'server/gs-brand.ts',
  'server/gs-client.ts',
  'server/gs-config.ts',
  'server/gs-contract.ts',
  'server/gs-endpoint.ts',
  'server/gs-skill-execution.ts',
  'server/gs-llm-models.ts',
  'server/gs-llm-proxy.ts',
  'server/gs-log-exporter.ts',
  'server/gs-server-route.ts',
  'server/gs-server-service.ts',
  'setup-wizard-copy.ts',
  'tray-locale.ts',
  'update-download.ts',
  'update-lifecycle.ts',
  'server-app-update.ts',
  'server-updates.ts',
  'window-chrome.ts',
  'window-options.ts',
  'windows-pwsh-sandbox.ts',
  'windows-volume-diagnostics.ts',
  'workspace-admission.ts',
  'agent-preset-compat.ts',
  // Compatibility chrome integration differs intentionally between channels.
  'client/window-service.ts',
  'bin.ts',
  'client/AdvancedFrame.tsx',
  // Both channels use the v0.1.5 main/rightbar contract; remaining differences
  // preserve channel identity and the beta-only compatibility frame.
  'client/desktop-settings.ts',
  'client/DesktopSettingsSection.tsx',
  'client/index.ts',
  'desktop-browser-access.ts',
  'desktop-dialog-window.ts',
  'desktop-plugins.ts',
  'desktop-terminal.ts',
  'diagnostic-export-worker.ts',
  'launch-environment.ts',
  'main.ts',
  'native-ui/setup-wizard/App.tsx',
  'product-identity.ts',
  'profile-manager.ts',
  'profile.ts',
  'safe-mode.ts',
  'setup-wizard-contract.ts',
  'startup-recovery-window.ts',
  'updates.ts',
  'webserver.ts',
])

function files(directory, base = directory) {
  const result = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...files(path, base))
    else if (entry.isFile()) result.push(relative(base, path).split(sep).join('/'))
  }
  return result
}

const sharedPaths = new Set([...files(stableRoot), ...files(betaRoot), ...betaOnlyPaths])
const differences = []
for (const path of [...sharedPaths].sort()) {
  if (allowedDifferences.has(path)) continue
  let stable
  let beta
  try { stable = readFileSync(join(stableRoot, path)) } catch { stable = undefined }
  try { beta = readFileSync(join(betaRoot, path)) } catch { beta = undefined }
  if (betaOnlyPaths.has(path)) {
    if (stable !== undefined || beta === undefined) differences.push(`${path} (must exist only in beta)`)
    continue
  }
  if (stable === undefined || beta === undefined || !stable.equals(beta)) differences.push(path)
}

if (differences.length > 0) {
  throw new Error(`Desktop variant source drift is not declared:\n${differences.map(path => `- src/${path}`).join('\n')}`)
}

process.stdout.write(`verify-desktop-variants: ${String(sharedPaths.size - allowedDifferences.size - betaOnlyPaths.size)} shared source files are aligned; beta-only compatibility chrome and Host experiment are isolated\n`)
