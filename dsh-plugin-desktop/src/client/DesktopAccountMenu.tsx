/** Desktop account launcher rendered in the sidebar footer. */

import { Menu } from '@base-ui/react/menu'
import { ChevronDown, Info, LogOut, Settings, WandSparkles } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { GsSessionView } from '../server/gs-contract.ts'
import type { DesktopGsAccountApi } from './gs-account-api.ts'
import type { SettingsNavigation } from './settings-navigation.ts'

/** Services composed into the account launcher registration. */
export interface DesktopAccountMenuInjected {
  readonly gsAccount: DesktopGsAccountApi
  readonly settingsNavigation: SettingsNavigation
  readonly version: string
}

/** Sidebar-owned wide/rail state plus Desktop account services. */
export type DesktopAccountMenuProps =
  PropsRuntime<'sidebar.footer.action'>
  & PropsLocale<'desktop.settings'>
  & InjectFace<DesktopAccountMenuInjected>

function accountInitial(name: string): string {
  return Array.from(name.trim())[0]?.toLocaleUpperCase() ?? '?'
}

/** Render the account card and its keyboard-accessible popup menu. */
export function DesktopAccountMenu({
  wide,
  t,
  gsAccount,
  settingsNavigation,
  version,
}: DesktopAccountMenuProps) {
  const [session, setSession] = useState<GsSessionView>()
  const [failed, setFailed] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutFailed, setLogoutFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    gsAccount.readSession()
      .then((value) => { if (!cancelled) setSession(value) })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [gsAccount])

  const user = session?.status === 'signed-in' ? session.user : undefined
  const name = user !== undefined
    ? user.displayName
    : session?.status === 'signed-out'
      ? t('accountSignedOut')
      : failed ? t('accountMenuUnavailable') : t('loading')
  const role = user !== undefined
    ? (/^(?:admin|administrator)$/iu.test(user.role)
        ? t('accountMenuAdministrator')
        : user.role)
    : ''
  const initial = useMemo(() => accountInitial(name), [name])

  const logout = async (): Promise<void> => {
    if (loggingOut) return
    setLoggingOut(true)
    setLogoutFailed(false)
    try {
      await gsAccount.logout()
    } catch {
      setLoggingOut(false)
      setLogoutFailed(true)
    }
  }

  return (
    <Menu.Root>
      <Menu.Trigger
        className={`dshDesktopAccountTrigger${wide ? '' : ' dshDesktopAccountTriggerRail'}`}
        aria-label={t('accountMenuOpen')}
      >
        <span className="dshDesktopAccountAvatar" aria-hidden="true">{initial}</span>
        {wide && (
          <>
            <span className="dshDesktopAccountIdentity">
              <strong>{name}</strong>
              {role !== '' && <span>{role}</span>}
            </span>
            <ChevronDown className="dshDesktopAccountChevron" size={16} aria-hidden="true" />
          </>
        )}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          className="dshDesktopAccountPositioner"
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={8}
        >
          <Menu.Popup className="dshDesktopAccountPopup">
            <Menu.Item className="dshDesktopAccountItem" onClick={() => { settingsNavigation.open('desktop') }}>
              <Settings size={18} aria-hidden="true" />
              <span>{t('accountMenuSettings')}</span>
            </Menu.Item>
            <Menu.Item className="dshDesktopAccountItem" onClick={() => { settingsNavigation.open('desktop-skills') }}>
              <WandSparkles size={18} aria-hidden="true" />
              <span>{t('accountMenuSkills')}</span>
            </Menu.Item>
            <Menu.Item className="dshDesktopAccountItem" onClick={() => { settingsNavigation.open('desktop-about') }}>
              <Info size={18} aria-hidden="true" />
              <span>{t('accountMenuAbout')}</span>
              <span className="dshDesktopAccountVersion">v{version}</span>
            </Menu.Item>
            <Menu.Item
              className="dshDesktopAccountItem dshDesktopAccountItemDanger"
              disabled={loggingOut}
              closeOnClick={false}
              onClick={() => { void logout() }}
            >
              <LogOut size={18} aria-hidden="true" />
              <span>{loggingOut ? t('accountMenuLoggingOut') : t('accountMenuLogout')}</span>
            </Menu.Item>
            {logoutFailed && <p className="dshDesktopAccountError" role="alert">{t('operationFailed')}</p>}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
