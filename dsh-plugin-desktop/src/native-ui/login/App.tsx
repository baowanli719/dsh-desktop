import { useEffect, useState, type FormEvent } from 'react'
import {
  ArrowRight,
  KeyRound,
  LoaderCircle,
  Mail,
  ShieldCheck,
  TriangleAlert,
  UserRound,
} from 'lucide-react'
import { DESKTOP_BRAND_LOGO_DATA_URI } from '../../client/brand-logo.ts'
import { DESKTOP_LOGIN_SUCCESS_HREF } from '../../login-contract.ts'
import { desktopLoginCopy } from '../../login-copy.ts'
import type {
  GsCaptcha,
  GsEmailCodeResponse,
  GsServerMetaView,
  GsSessionView,
} from '../../server/gs-contract.ts'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { Label } from '../components/ui/label.tsx'
import { DesktopFrame } from '../shared/DesktopFrame.tsx'
import { desktopLoginRpc } from './bridge.ts'
import {
  captchaFieldVisible,
  clientBelowMinimum,
  decodeDesktopLoginInput,
  desktopLoginFailureView,
  desktopLoginSubmitBlocked,
  resolveLoginMethod,
  tickCountdown,
  type DesktopLoginMethod,
} from './logic.ts'

/** Pre-boot gsclaw-server login surface rendered inside DesktopLoginWindow. */
export function LoginApp(): JSX.Element {
  const boot = decodeDesktopLoginInput(window.location.search)
  if (boot === undefined) {
    // The window only loads with the exact state tuple; anything else is a
    // corrupted local document and must not render an interactive form.
    return <main className="p-6 text-sm text-muted-foreground">dsh-login: invalid window state</main>
  }
  return <LoginForm locale={boot.locale} clientVersion={boot.input.clientVersion} />
}

function LoginForm({ locale, clientVersion }: { readonly locale: 'zh' | 'en', readonly clientVersion: string }): JSX.Element {
  const copy = desktopLoginCopy(locale)
  const [meta, setMeta] = useState<GsServerMetaView>()
  const [offline, setOffline] = useState(false)
  const [method, setMethod] = useState<DesktopLoginMethod>('email_code')
  const [account, setAccount] = useState('')
  const [credential, setCredential] = useState('')
  const [maskedEmail, setMaskedEmail] = useState('')
  const [countdown, setCountdown] = useState(0)
  const [captcha, setCaptcha] = useState<GsCaptcha | null>(null)
  const [captchaInput, setCaptchaInput] = useState('')
  // A null captcha answer means the server predates captchas; hide the field.
  const [captchaSupported, setCaptchaSupported] = useState(true)
  const [lockRemaining, setLockRemaining] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  // Handshake first: the server decides which login methods the form renders.
  useEffect(() => {
    let cancelled = false
    desktopLoginRpc<GsServerMetaView>('meta')
      .then((result) => {
        if (cancelled) return
        setMeta(result)
        setOffline(false)
        setMethod(current => result.meta.loginMethods.includes(current) ? current : resolveLoginMethod(result.meta.loginMethods))
      })
      .catch(() => {
        if (!cancelled) setOffline(true)
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (countdown <= 0) return
    const timer = window.setInterval(() => { setCountdown(tickCountdown) }, 1000)
    return () => { window.clearInterval(timer) }
  }, [countdown])

  useEffect(() => {
    if (lockRemaining <= 0) return
    const timer = window.setInterval(() => { setLockRemaining(tickCountdown) }, 1000)
    return () => { window.clearInterval(timer) }
  }, [lockRemaining])

  const refreshCaptcha = async (): Promise<void> => {
    setCaptchaInput('')
    try {
      const next = await desktopLoginRpc<GsCaptcha | null>('captcha')
      setCaptcha(next)
      if (next === null) setCaptchaSupported(false)
    } catch {
      // Keep the refresh path alive on transient failures; a 404 already
      // arrives as null from the Host-owned service.
      setCaptcha(null)
    }
  }

  // Password login needs a fresh one-time captcha up front; the email code is
  // its own second factor.
  useEffect(() => {
    if (method === 'password' && meta !== undefined && captchaSupported && captcha === null) {
      void refreshCaptcha()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, meta, captchaSupported])

  const methods = meta?.meta.loginMethods ?? []
  const clientTooOld = meta !== undefined && clientBelowMinimum(clientVersion, meta.meta.minimumClientVersion)
  // The pre-login meta handshake doubles as the brand delivery channel;
  // servers that predate the field keep the cached/default copy.
  const metaBrand = meta?.meta.brand?.name?.trim()
  const heading = metaBrand !== undefined && metaBrand !== '' ? metaBrand : copy.heading

  const switchMethod = (next: DesktopLoginMethod): void => {
    setMethod(next)
    setCredential('')
    // A captcha left over from an earlier visit may be expired; fetch anew.
    setCaptcha(null)
    setCaptchaInput('')
    setError('')
  }

  const sendCode = async (): Promise<void> => {
    setSending(true)
    setError('')
    try {
      const result = await desktopLoginRpc<GsEmailCodeResponse>('email-code', { account: account.trim() })
      setMaskedEmail(result.maskedEmail)
      setCountdown(result.resendIn)
    } catch (cause) {
      const view = desktopLoginFailureView(cause, copy.loginFailed)
      if (view.kind === 'locked') setLockRemaining(view.retryAfter)
      else setError(view.kind === 'offline' ? copy.offline : view.message)
    } finally {
      setSending(false)
    }
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      if (method === 'password') {
        await desktopLoginRpc<GsSessionView>('password-login', {
          username: account.trim(),
          password: credential,
          ...(captcha === null ? {} : { captchaId: captcha.captchaId, captchaCode: captchaInput.trim() }),
        })
      } else {
        await desktopLoginRpc<GsSessionView>('email-login', { account: account.trim(), code: credential.trim() })
      }
      // The Host already holds the session; the success navigation closes the
      // window and lets startup continue into boot().
      window.location.href = DESKTOP_LOGIN_SUCCESS_HREF
    } catch (cause) {
      const view = desktopLoginFailureView(cause, copy.loginFailed)
      if (view.kind === 'offline') {
        setOffline(true)
      } else if (view.kind === 'locked') {
        setLockRemaining(view.retryAfter)
      } else {
        setError(view.message)
      }
      // Captchas are single-use: every failed attempt invalidates the image.
      if (method === 'password') void refreshCaptcha()
    } finally {
      setSubmitting(false)
    }
  }

  const submitBlocked = desktopLoginSubmitBlocked({
    submitting,
    offline,
    clientTooOld,
    metaReady: meta !== undefined,
    lockRemaining,
    account,
    credential,
    method,
    captchaSupported,
    captchaInput,
  })

  return (
    <main className="dshLoginSurface flex min-h-screen flex-col bg-background text-foreground">
      <DesktopFrame />
      <section className="flex flex-1 items-center justify-center p-6">
        <div role="dialog" aria-labelledby="dsh-login-title" className="w-full max-w-sm rounded-2xl bg-card p-8">
          <div className="mb-6 flex flex-col items-center gap-3 text-center">
            <img src={DESKTOP_BRAND_LOGO_DATA_URI} alt="" className="size-14 rounded-xl" />
            <div>
              <h2 id="dsh-login-title" className="text-xl font-semibold">{heading}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{copy.subheading}</p>
            </div>
          </div>

          {methods.length > 1 && (
            <div role="tablist" aria-label={heading} className="mb-5 grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
              {methods.includes('password') && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={method === 'password'}
                  data-active={method === 'password' ? 'true' : undefined}
                  className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors data-active:bg-background data-active:text-foreground data-active:shadow-xs"
                  onClick={() => { switchMethod('password') }}
                >
                  {copy.passwordTab}
                </button>
              )}
              {methods.includes('email_code') && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={method === 'email_code'}
                  data-active={method === 'email_code' ? 'true' : undefined}
                  className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors data-active:bg-background data-active:text-foreground data-active:shadow-xs"
                  onClick={() => { switchMethod('email_code') }}
                >
                  {copy.emailCodeTab}
                </button>
              )}
            </div>
          )}

          <form onSubmit={(event) => { void submit(event) }} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dsh-login-account">{copy.accountLabel}</Label>
              <div className="relative">
                <UserRound size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="dsh-login-account"
                  className="pl-9"
                  value={account}
                  autoComplete="username"
                  placeholder={copy.accountPlaceholder}
                  onChange={event => { setAccount(event.target.value) }}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dsh-login-credential">{method === 'password' ? copy.passwordLabel : copy.emailCodeLabel}</Label>
              <div className="relative">
                {method === 'password'
                  ? <KeyRound size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  : <Mail size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />}
                <Input
                  id="dsh-login-credential"
                  className={method === 'email_code' ? 'pl-9 pr-24' : 'pl-9'}
                  type={method === 'password' ? 'password' : 'text'}
                  inputMode={method === 'email_code' ? 'numeric' : undefined}
                  value={credential}
                  autoComplete={method === 'password' ? 'current-password' : 'one-time-code'}
                  placeholder={method === 'password' ? copy.passwordPlaceholder : copy.emailCodePlaceholder}
                  onChange={event => { setCredential(event.target.value) }}
                />
                {method === 'email_code' && (
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-xs text-primary disabled:text-muted-foreground"
                    disabled={sending || countdown > 0 || account.trim().length === 0}
                    onClick={() => { void sendCode() }}
                  >
                    {sending ? copy.sendingCode : countdown > 0 ? copy.resendIn(countdown) : copy.sendCode}
                  </button>
                )}
              </div>
            </div>
            {captchaFieldVisible(method, captchaSupported) && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="dsh-login-captcha">{copy.captchaLabel}</Label>
                <div className="relative">
                  <ShieldCheck size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="dsh-login-captcha"
                    className="pl-9 pr-28"
                    value={captchaInput}
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder={copy.captchaPlaceholder}
                    onChange={event => { setCaptchaInput(event.target.value) }}
                  />
                  {captcha !== null && (
                    // The SVG only ever renders as an inert <img> data URL, so
                    // server markup can never execute inside the document.
                    <img
                      className="absolute right-2 top-1/2 h-7 w-24 -translate-y-1/2 cursor-pointer rounded-sm border bg-white object-contain"
                      src={`data:image/svg+xml;utf8,${encodeURIComponent(captcha.svg)}`}
                      alt={copy.captchaAlt}
                      title={copy.captchaAlt}
                      onClick={() => { void refreshCaptcha() }}
                    />
                  )}
                </div>
              </div>
            )}
            {maskedEmail !== '' && <p className="text-xs text-muted-foreground">{copy.codeSentTo(maskedEmail)}</p>}
            {(error !== '' || offline || clientTooOld || lockRemaining > 0) && (
              <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                <TriangleAlert size={14} className="mt-0.5 shrink-0" />
                <span>
                  {clientTooOld
                    ? copy.clientTooOld(meta?.meta.minimumClientVersion ?? '')
                    : offline
                      ? copy.offline
                      : lockRemaining > 0
                        ? copy.locked(Math.floor(lockRemaining / 60), lockRemaining % 60)
                        : error}
                </span>
              </div>
            )}
            <Button type="submit" disabled={submitBlocked} className="mt-1 w-full">
              {submitting
                ? <><LoaderCircle size={16} className="animate-spin" /> {copy.submitting}</>
                : <>{copy.submit} <ArrowRight size={16} /></>}
            </Button>
          </form>

          <div className="mt-5 flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <span
              aria-hidden="true"
              className={offline ? 'inline-block size-1.5 rounded-full bg-destructive' : 'inline-block size-1.5 rounded-full bg-emerald-500'}
            />
            {meta !== undefined
              ? copy.connectedTo(meta.meta.serviceName, clientVersion)
              : offline
                ? copy.offline
                : copy.connecting}
          </div>
        </div>
      </section>
      <footer className="pb-4 text-center text-xs text-muted-foreground">{copy.footer}</footer>
    </main>
  )
}
