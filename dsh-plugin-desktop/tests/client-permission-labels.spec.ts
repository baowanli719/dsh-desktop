import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DESKTOP_PERMISSION_DESCRIPTIONS,
  DESKTOP_PERMISSION_LABELS,
  installDesktopPermissionLabels,
} from '../src/client/permission-labels.ts'

afterEach(() => {
  globalThis.__GS_PERMISSION_LABELS__ = undefined
  globalThis.__GS_PERMISSION_DESCRIPTIONS__ = undefined
})

describe('installDesktopPermissionLabels', () => {
  it('publishes the Chinese preset names keyed by preset value', () => {
    installDesktopPermissionLabels()
    expect(globalThis.__GS_PERMISSION_LABELS__).toEqual({
      'read-only': '只读',
      'workspace-write': '默认',
      'danger-full-access': '全自动',
    })
    expect(globalThis.__GS_PERMISSION_DESCRIPTIONS__).toEqual({
      'read-only': '仅可读取文件，写入及受限操作会询问',
      'workspace-write': '可读写工作区，关键操作会询问',
      'danger-full-access': '所有操作无需确认直接执行',
    })
  })

  it('accepts an overriding label map', () => {
    installDesktopPermissionLabels({ 'read-only': '仅查看' })
    expect(globalThis.__GS_PERMISSION_LABELS__).toEqual({ 'read-only': '仅查看' })
    expect(DESKTOP_PERMISSION_LABELS['read-only']).toBe('只读')
    expect(DESKTOP_PERMISSION_DESCRIPTIONS['danger-full-access']).toBe('所有操作无需确认直接执行')
  })
})

describe('permission-label client patches', () => {
  const conversationPatch = readFileSync(new URL(
    '../../patches/dsh-client-ui-conversation@0.1.2-rc.1.patch',
    import.meta.url,
  ), 'utf8')
  const presetsPatch = readFileSync(new URL(
    '../../patches/dsh-client-ui-permission-presets@0.1.2-rc.1.patch',
    import.meta.url,
  ), 'utf8')

  it('renders the composer permission control with injected labels and descriptions', () => {
    for (const marker of [
      'function permissionLabel(value, name, t) {',
      'const injected = globalThis.__GS_PERMISSION_LABELS__?.[value];',
      'if (typeof injected === "string" && injected !== "") return injected;',
      'const injected = globalThis.__GS_PERMISSION_DESCRIPTIONS__?.[option.value];',
      'className: PermissionSelect_module_css_default.permissionMenu,',
      'currentValue === FULL_ACCESS && PermissionSelect_module_css_default.triggerAutomatic',
      'var(--dsw-alias-state-warn-label,#dd8629)',
    ]) {
      expect(conversationPatch).toContain(marker)
    }
  })

  it('uses fully localized Chinese copy in the automatic-mode risk warning', () => {
    expect(conversationPatch).toContain('"access.confirm.title": "确认启用全自动？"')
    expect(conversationPatch).toContain('"access.confirm.enable": "启用全自动"')
    expect(conversationPatch).toContain('启用全自动后，智能体将不再请求确认')
    expect(conversationPatch).toContain('"access.preset.fullAccess": "全自动"')
  })

  it('teaches the /permission popup and settings row the same injection', () => {
    for (const marker of [
      'function displayPermissionPreset(value, name, t) {',
      'const injected = globalThis.__GS_PERMISSION_LABELS__?.[value];',
      'if (typeof injected === "string" && injected !== "") return injected;',
    ]) {
      expect(presetsPatch).toContain(marker)
    }
  })
})
