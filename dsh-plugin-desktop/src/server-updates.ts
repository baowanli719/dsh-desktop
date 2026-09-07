/**
 * Cordis Host plugin for gsclaw-server-pushed application updates.
 *
 * The server delivers `config.appUpdate` inside login/refresh responses and
 * `GET /api/client-config`. This plugin subscribes to the Host-owned
 * ClientConfig cache, prompts natively when a strictly newer version reaches
 * this platform, and — only after the user confirms — downloads the installer
 * from its direct URL. A timer additionally pulls the config so updates
 * published while the app runs still arrive between login and refresh pushes.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from './runtime.ts'
import type {} from './server/gs-server-service.ts'
import { evaluateServerAppUpdate, parseServerAppUpdate } from './server-app-update.ts'

/** Stable Cordis plugin name. */
export const name = 'desktop-server-updates'

/** The desktop native adapter and the gsclaw-server client this plugin bridges. */
export const inject = ['desktopRuntime', 'gsServer']

const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Server-update prompt policy. */
export interface Config {
  /** Enable server-pushed update prompts. */
  enabled: boolean
  /** Delay between client-config pulls; aligns with the server's refresh cadence. */
  pullIntervalMs: number
  /** Delay before the first pull, giving session restoration time to push first. */
  initialPullDelayMs: number
}

/** Validated server-update prompt policy. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  pullIntervalMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(5 * 60 * 1000),
  initialPullDelayMs: z.number().step(1).min(0).max(MAX_TIMER_DELAY_MS).default(15_000),
})

/**
 * Register effect-scoped appUpdate subscription and periodic config pulls.
 * @param ctx - Host context carrying the desktop native adapter and the gsclaw-server client.
 * @param config - validated prompt and polling values.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => {
    if (!config.enabled) return () => {}
    const promptedVersions = new Set<string>()
    const downloads = new AbortController()
    let timer: NodeJS.Timeout | undefined

    const pull = (): void => {
      // A signed-out or offline pull fails routinely; the subscription stays
      // the source of truth and the next login/refresh republishes the config.
      void ctx.gsServer.getClientConfig().catch(() => {})
    }
    const scheduleNext = (): void => {
      timer = setTimeout(() => {
        pull()
        scheduleNext()
      }, config.pullIntervalMs)
    }
    timer = setTimeout(() => {
      pull()
      scheduleNext()
    }, config.initialPullDelayMs)

    const unsubscribe = ctx.gsServer.config.subscribe((snapshot) => {
      const appUpdate = parseServerAppUpdate(snapshot?.config.appUpdate)
      const evaluation = evaluateServerAppUpdate(
        appUpdate,
        ctx.desktopRuntime.updates.currentVersion,
        process.platform,
        process.arch,
        new Date(),
      )
      if (evaluation === null || promptedVersions.has(evaluation.version)) return
      const updates = ctx.desktopRuntime.updates
      const serverUpdates = updates.serverUpdates
      if (serverUpdates === undefined || updates.canDownload === false) {
        promptedVersions.add(evaluation.version)
        ctx.logger.info(
          `dsh-plugin-desktop: server update ${evaluation.version} is available, but this build cannot prompt or download it`,
        )
        return
      }
      promptedVersions.add(evaluation.version)
      void serverUpdates.promptUpdate(
        evaluation.version,
        evaluation.notes,
        evaluation.kind,
        ...(evaluation.kind === 'notify-only' ? [evaluation.availableFrom] : []),
      ).then((downloadNow) => {
        if (downloadNow !== true || evaluation.kind !== 'available') return
        return serverUpdates.downloadAndOpen(evaluation.url, evaluation.version, downloads.signal)
      }).catch((cause: unknown) => {
        if (downloads.signal.aborted) return
        ctx.logger.warn(
          `dsh-plugin-desktop: server update ${evaluation.version} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        )
      })
    })

    return () => {
      unsubscribe()
      if (timer !== undefined) clearTimeout(timer)
      downloads.abort()
    }
  }, 'dsh-plugin-desktop: gsclaw-server appUpdate prompts and confirmed downloads')
}
