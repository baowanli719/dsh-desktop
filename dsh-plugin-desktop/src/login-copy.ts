/** Bilingual copy for the pre-boot gsclaw-server login window. */

import { currentBrand, interpolateBrand } from './brand.ts'
import type { DesktopLocale } from './runtime.ts'

/** Every user-facing string rendered by the login document. */
export interface DesktopLoginCopy {
  readonly title: string
  readonly heading: string
  readonly subheading: string
  readonly passwordTab: string
  readonly emailCodeTab: string
  readonly accountLabel: string
  readonly accountPlaceholder: string
  readonly passwordLabel: string
  readonly passwordPlaceholder: string
  readonly emailCodeLabel: string
  readonly emailCodePlaceholder: string
  readonly sendCode: string
  readonly sendingCode: string
  readonly captchaLabel: string
  readonly captchaPlaceholder: string
  readonly captchaAlt: string
  readonly submit: string
  readonly submitting: string
  readonly offline: string
  readonly connecting: string
  readonly loginFailed: string
  readonly footer: string
  readonly codeSentTo: (maskedEmail: string) => string
  readonly resendIn: (seconds: number) => string
  readonly locked: (minutes: number, seconds: number) => string
  readonly clientTooOld: (minimum: string) => string
  readonly connectedTo: (serviceName: string, version: string) => string
}

const zh: DesktopLoginCopy = {
  title: '登录{brand}',
  heading: '{brand}',
  subheading: '使用 OA 账号登录工作台',
  passwordTab: '密码登录',
  emailCodeTab: '邮箱验证码',
  accountLabel: 'OA 账号',
  accountPlaceholder: '请输入 OA 账号',
  passwordLabel: '登录密码',
  passwordPlaceholder: '请输入密码',
  emailCodeLabel: '邮箱验证码',
  emailCodePlaceholder: '6 位验证码',
  sendCode: '获取验证码',
  sendingCode: '发送中',
  captchaLabel: '图形验证码',
  captchaPlaceholder: '请输入图中算式结果',
  captchaAlt: '图形验证码，点击刷新',
  submit: '安全登录',
  submitting: '正在登录…',
  offline: '无法连接服务端，请检查网络或稍后重试',
  connecting: '正在连接服务端…',
  loginFailed: '登录失败',
  footer: '企业内部系统 · 请勿处理非工作信息',
  codeSentTo: maskedEmail => `验证码已发送至 ${maskedEmail}`,
  resendIn: seconds => `${String(seconds)}s`,
  locked: (minutes, seconds) => `失败次数过多，账号已锁定，请 ${String(minutes)} 分 ${String(seconds)} 秒后重试`,
  clientTooOld: minimum => `客户端版本过低，请升级至 ${minimum} 及以上`,
  connectedTo: (serviceName, version) => `已连接 ${serviceName} · v${version}`,
}

const en: DesktopLoginCopy = {
  title: 'Sign in to {brand}',
  heading: '{brand}',
  subheading: 'Sign in with your OA account',
  passwordTab: 'Password',
  emailCodeTab: 'Email code',
  accountLabel: 'OA account',
  accountPlaceholder: 'Enter your OA account',
  passwordLabel: 'Password',
  passwordPlaceholder: 'Enter your password',
  emailCodeLabel: 'Email code',
  emailCodePlaceholder: '6-digit code',
  sendCode: 'Send code',
  sendingCode: 'Sending',
  captchaLabel: 'Captcha',
  captchaPlaceholder: 'Enter the result shown',
  captchaAlt: 'Captcha image, click to refresh',
  submit: 'Sign in',
  submitting: 'Signing in…',
  offline: 'Cannot reach the server. Check your network and try again.',
  connecting: 'Connecting to the server…',
  loginFailed: 'Sign-in failed',
  footer: 'Internal system · do not process non-work information',
  codeSentTo: maskedEmail => `Code sent to ${maskedEmail}`,
  resendIn: seconds => `${String(seconds)}s`,
  locked: (minutes, seconds) => `Too many failures. Try again in ${String(minutes)}m ${String(seconds)}s.`,
  clientTooOld: minimum => `This client is too old. Please upgrade to ${minimum} or later.`,
  connectedTo: (serviceName, version) => `Connected to ${serviceName} · v${version}`,
}

/** Resolve the login-window copy for one Desktop locale against the effective brand. */
export function desktopLoginCopy(locale: DesktopLocale, brand = currentBrand().name): DesktopLoginCopy {
  return interpolateBrand(locale === 'zh' ? zh : en, brand)
}
