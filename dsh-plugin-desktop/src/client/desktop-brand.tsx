/** Desktop-owned brand occupants for the generic sidebar and hero brand slots. */

import { useEffect, useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { DESKTOP_BRAND_LOGO_DATA_URI } from './brand-logo.ts'
import { createDesktopGsBrandApi } from './gs-brand-api.ts'

/** Locale namespace of the desktop brand occupants. */
export const DESKTOP_BRAND_LOCALE_NAMESPACE = 'desktop.brand'

const zh = { name: '办公 Agent' } as const
const en: Record<DesktopBrandLocaleKey, string> = { name: 'gs-worker' }

type DesktopBrandLocaleKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Desktop brand occupant copy. */
    'desktop.brand': DesktopBrandLocaleKey
  }
}

type DesktopBrandMarkProps = HeroBrandMarkOwnerProps & SidebarBrandMarkOwnerProps

/**
 * Render the desktop brand mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the gs-worker cloud mark.
 */
export function DesktopBrandMark({ size, className }: DesktopBrandMarkProps) {
  return <img src={DESKTOP_BRAND_LOGO_DATA_URI} width={size} height={size} className={className} alt="" />
}

/** Renderer-composed props for the sidebar brand-name occupant. */
export type DesktopBrandNameProps = PropsLocale<typeof DESKTOP_BRAND_LOCALE_NAMESPACE>

/**
 * Render the desktop brand name for the sidebar brand row. The server-delivered
 * brand is fetched on mount; the locale dictionary stays the fallback.
 * @param props - Locale seat supplied by the slot runtime.
 * @returns the effective desktop brand name.
 */
export function DesktopBrandName({ t }: DesktopBrandNameProps) {
  const [name, setName] = useState<string>()
  useEffect(() => {
    let cancelled = false
    createDesktopGsBrandApi().readBrand()
      .then((brand) => { if (!cancelled) setName(brand.name) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])
  return <span>{name ?? t('name')}</span>
}

/**
 * Fill the generic brand slots the upstream official occupant would otherwise own.
 * @param ctx - Client root context.
 */
export function applyDesktopBrand(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.locale.register(DESKTOP_BRAND_LOCALE_NAMESPACE, { zh, en }),
    'dsh-plugin-desktop: brand dictionaries',
  )
  ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({
    name: 'sidebar.brand.mark',
  }, DesktopBrandMark))
  ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({
    name: 'sidebar.brand.name',
    locale: DESKTOP_BRAND_LOCALE_NAMESPACE,
  }, DesktopBrandName))
  ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({
    name: 'conversation.hero.brand.mark',
  }, DesktopBrandMark))
}
