/**
 * Wire contract for the gsclaw-server client layer.
 *
 * Two surfaces share this module: the outbound gsclaw-server API shapes the
 * Host consumes, and the private same-origin renderer routes the Host exposes
 * (`/api/gs-server/*`) so the bundled login UI never touches tokens directly.
 */

/** Server-delivered brand copy; either field falls back to the built-in default. */
export interface GsBrandConfig {
  readonly name?: string
  readonly headline?: string
}

/** Server metadata returned by the public `GET /api/v1/meta` handshake. */
export interface GsServerMeta {
  readonly serviceName: string
  readonly serviceVersion: string
  readonly loginMethods: readonly ('password' | 'email_code')[]
  readonly minimumClientVersion: string
  readonly llmProxy: boolean
  /** Pre-login brand delivery; absent on servers that predate the field. */
  readonly brand?: GsBrandConfig | null
}

/** One-time graphical captcha issued by `GET /api/auth/captcha`. */
export interface GsCaptcha {
  readonly captchaId: string
  readonly svg: string
  readonly expiresIn: number
}

/** Login-method switches returned by `GET /api/auth/methods`. */
export interface GsAuthMethods {
  readonly methods: {
    readonly password: boolean
    readonly wecom: boolean
    readonly email: boolean
  }
}

/** Authenticated user projection shared by login, refresh, and config responses. */
export interface GsAuthUser {
  readonly id: number
  readonly username: string
  readonly displayName: string
  readonly role: string
}

/** Rotating token pair issued by login and `POST /api/v1/auth/refresh`. */
export interface GsTokenPair {
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresIn: number
}

/** Settings-page visibility controlled by the server. */
export type GsSettingsPageMode = 'hidden' | 'readonly' | 'editable'

/**
 * Skill control table entry. Per skill, `off` removes it from the effective
 * catalog while `on` or an unlisted skill follows the delivered catalog; the
 * reserved key `SKILLs` is the master switch — `off` disables the whole skill
 * feature.
 */
export type GsSkillControl = 'on' | 'off'

/**
 * Client-visible model provider. The gateway never echoes baseUrl or apiKey;
 * clients only receive the protocol and the selectable model list.
 */
export interface GsModelProviderEntry {
  readonly api: 'openai-completions'
  readonly models: readonly {
    readonly id: string
    readonly name?: string
    readonly input?: readonly string[]
  }[]
}

/** Client-visible model configuration; null keeps local model settings. */
export interface GsModelsConfig {
  readonly providers: Record<string, GsModelProviderEntry>
  /** Default model in `providerId/modelId` form. */
  readonly defaultPrimary?: string
}

/** Server-pushed application update notice; null disables update prompts. */
export interface GsAppUpdateConfig {
  readonly version: string
  readonly notes?: readonly string[]
  readonly downloads: {
    readonly windowsX64?: string
    readonly macArm?: string
    readonly macIntel?: string
  }
  readonly availableFrom?: string
  readonly downloadWindow?: { readonly start: string, readonly end: string } | null
}

/** Server-pushed scrolling notice banner; null hides the banner. */
export interface GsNoticeConfig {
  readonly text: string
  readonly startAt?: string
  readonly endAt?: string
  readonly dismissible?: boolean
}

/** Effective client configuration pushed at login/refresh and via `/api/client-config`. */
export interface GsClientConfig {
  readonly version: number
  readonly agent: {
    readonly sandboxProfile: 'read-only' | 'workspace-write' | 'tool-mediated'
    readonly approvalPolicy: 'plan' | 'ask' | 'policy-auto'
    readonly dataClass: 'public' | 'internal' | 'sensitive' | 'confidential'
  }
  readonly features: { readonly customModel: boolean }
  readonly settingsPages: Record<string, GsSettingsPageMode>
  readonly permissions: {
    readonly allowSubmit: boolean
    readonly allowExternalSkillInstall: boolean
  }
  readonly skills: Record<string, GsSkillControl>
  readonly models: GsModelsConfig | null
  readonly appUpdate: GsAppUpdateConfig | null
  readonly notice: GsNoticeConfig | null
  /** Server-pushed brand copy; null or absent keeps the cached/default brand. */
  readonly brand?: GsBrandConfig | null
}

/** Success body of password login and email-code verify. */
export interface GsLoginResponse {
  readonly token: string
  readonly tokens?: GsTokenPair
  readonly user: GsAuthUser
  readonly config: GsClientConfig
}

/** Success body of `POST /api/auth/email/send-code`. */
export interface GsEmailCodeResponse {
  readonly ok: boolean
  readonly maskedEmail: string
  readonly expiresIn: number
  readonly resendIn: number
}

/** Success body of `POST /api/v1/auth/refresh`. */
export interface GsRefreshResponse {
  readonly tokens: GsTokenPair
  readonly user: GsAuthUser
  readonly config: GsClientConfig
}

/** Success body of the authenticated `GET /api/client-config`. */
export interface GsClientConfigResponse {
  readonly user: GsAuthUser
  readonly config: GsClientConfig
}

/* ------------------------------------------------------------------ */
/* Server-owned skill distribution.                                   */
/* ------------------------------------------------------------------ */

/** One skill summary from `GET /api/skills`; the server only sends enabled skills. */
export interface GsServerSkill {
  readonly id: string
  readonly name: string
  readonly displayName: string
  readonly description: string
  readonly version: string
  readonly content: string
  readonly enabled: boolean
  readonly runtimeType: string
}

/** Success body of `GET /api/skills`. */
export interface GsSkillsResponse {
  readonly skills: readonly GsServerSkill[]
}

/** One base64-encoded skill bundle file from `GET /api/skills/:name/files`. */
export interface GsSkillFile {
  readonly path: string
  readonly base64: string
}

/** Success body of `GET /api/skills/:name/files`. */
export interface GsSkillFilesResponse {
  readonly name: string
  readonly files: readonly GsSkillFile[]
}

/** One row of the fire-and-forget `POST /api/skills/report-installed` body. */
export interface GsInstalledSkillReport {
  readonly id: string
  readonly name: string
  readonly source: 'server'
  readonly riskLevel?: string
  readonly contentHash?: string
}

/* ------------------------------------------------------------------ */
/* Private renderer routes served by the Host webServer.              */
/* ------------------------------------------------------------------ */

/** Query the current endpoint and server handshake metadata. */
export const GS_SERVER_META_PATH = '/api/gs-server/meta'

/** Issue a fresh graphical captcha; null when the server predates captchas. */
export const GS_SERVER_CAPTCHA_PATH = '/api/gs-server/captcha'

/** Password login through the Host-owned credential channel. */
export const GS_SERVER_LOGIN_PATH = '/api/gs-server/login'

/** Send an email verification code for one account. */
export const GS_SERVER_EMAIL_CODE_PATH = '/api/gs-server/email-code'

/** Email-code login through the Host-owned credential channel. */
export const GS_SERVER_EMAIL_LOGIN_PATH = '/api/gs-server/email-login'

/** Revoke the session family and drop all local credential state. */
export const GS_SERVER_LOGOUT_PATH = '/api/gs-server/logout'

/** Read the current session state without exposing tokens. */
export const GS_SERVER_SESSION_PATH = '/api/gs-server/session'

/** Read the server-delivered skill catalog and its latest sync status. */
export const GS_SERVER_SKILLS_PATH = '/api/gs-server/skills'

/** Read the effective brand copy resolved by the Host brand store. */
export const GS_SERVER_BRAND_PATH = '/api/gs-server/brand'

/** Renderer-safe brand view; always concrete after default/cache resolution. */
export interface GsBrandView {
  readonly name: string
  readonly headline: string
}

/** Renderer-safe session view; tokens never leave the main process. */
export interface GsSessionView {
  /** Whether the Host holds a usable access token. */
  readonly status: 'signed-out' | 'signed-in'
  /** Effective gsclaw-server endpoint in use. */
  readonly endpoint: string
  /** Authenticated user, present only while signed in. */
  readonly user?: GsAuthUser
}

/** Meta route response: the configured endpoint plus the live handshake. */
export interface GsServerMetaView {
  readonly endpoint: string
  readonly meta: GsServerMeta
}

/** Renderer-safe view of one server-delivered skill. */
export interface GsSkillViewItem {
  readonly name: string
  readonly displayName?: string
  readonly version?: string
  readonly description: string
}

/** Renderer-safe server-skill sync view; bundle content stays in the main process. */
export interface GsSkillsView {
  /** Latest synchronization outcome recorded by the server skill provider. */
  readonly status: 'idle' | 'ok' | 'error' | 'signed-out'
  /** ISO timestamp of the last successful `GET /api/skills`. */
  readonly syncedAt?: string
  readonly skills: readonly GsSkillViewItem[]
  /** Whether the reserved `SKILLs` master switch disabled the whole skill feature. */
  readonly masterOff?: boolean
  /** Count of delivered skills suppressed by a per-skill `off` switch. */
  readonly switchedOff?: number
}

/** Exact body accepted by the password-login route. */
export interface GsPasswordLoginRequest {
  readonly username: string
  readonly password: string
  readonly captchaId?: string
  readonly captchaCode?: string
}

/** Successful password login returns the fresh session view. */
export type GsPasswordLoginResponse = GsSessionView

/** Exact body accepted by the email-code route. */
export interface GsEmailCodeRequest {
  readonly account: string
}

/** Successful send-code handoff; the email address stays masked. */
export type GsEmailCodeRouteResponse = GsEmailCodeResponse

/** Exact body accepted by the email-login route. */
export interface GsEmailLoginRequest {
  readonly account: string
  readonly code: string
}

/** Successful email login returns the fresh session view. */
export type GsEmailLoginResponse = GsSessionView

/** Exact empty body accepted by the logout route. */
export type GsLogoutRequest = Readonly<Record<string, never>>

/** Successful logout handoff. */
export interface GsLogoutResponse {
  readonly accepted: true
}

/** Stable renderer failure shape; carries the gateway code when one exists. */
export interface GsServerErrorResponse {
  readonly error: string
  readonly code?: string
  readonly retryAfter?: number
}
