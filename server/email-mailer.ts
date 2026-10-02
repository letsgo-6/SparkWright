// SPDX-License-Identifier: MPL-2.0
import nodemailer from 'nodemailer'
import { normalizeEmail, validEmail } from './email-identity'
import { permissionError } from './permissions'

export interface RegistrationMailer { ready(): void; send(email: string, code: string): Promise<void> }
export function smtpConfig() {
  const value = (key: string) => {
    const text = process.env[key]?.trim()
    if (!text || /[\r\n]/.test(text) || /^<[^>]+>$/.test(text)) throw permissionError(503, 'mail_unavailable', '注册邮件尚未配置，请联系维护者；已有账号仍可登录')
    return text
  }
  const host = value('EMAIL_SMTP_HOST'), rawPort = value('EMAIL_SMTP_PORT'), secure = value('EMAIL_SMTP_SECURE')
  const user = normalizeEmail(value('EMAIL_SMTP_USER')), pass = value('EMAIL_SMTP_PASS'), from = value('EMAIL_FROM')
  const address = /^(?:SparkWright\s*<([^<>]+)>|([^<>]+))$/.exec(from)
  const fromEmail = normalizeEmail(address?.[1] || address?.[2] || '')
  if (!/^[a-zA-Z0-9.:-]+$/.test(host) || !/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535 || !['true', 'false'].includes(secure)
    || !validEmail(user) || !validEmail(fromEmail) || fromEmail !== user || (Number(rawPort) === 465 && secure !== 'true')) {
    throw permissionError(503, 'mail_unavailable', '注册邮件配置无效，请联系维护者')
  }
  return { host, port: Number(rawPort), secure: secure === 'true', user, pass, from: { name: 'SparkWright', address: fromEmail } }
}

export function createRegistrationMailer(): RegistrationMailer {
  let transport: ReturnType<typeof nodemailer.createTransport> | undefined
  let config: ReturnType<typeof smtpConfig>
  const ready = () => {
    if (transport) return
    config = smtpConfig()
    transport = nodemailer.createTransport({ host: config.host, port: config.port, secure: config.secure,
      auth: { user: config.user, pass: config.pass }, tls: { rejectUnauthorized: true },
      connectionTimeout: 10000, greetingTimeout: 10000, dnsTimeout: 10000, socketTimeout: 30000,
      logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true })
  }
  return { ready, async send(email, code) {
    ready()
    if (!validEmail(email) || email !== normalizeEmail(email) || !/^\d{6}$/.test(code)) throw new Error('invalid_mail_input')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        transport!.sendMail({ from: config.from, to: { address: email, name: '' }, subject: 'SparkWright 注册验证码',
          text: `你的 SparkWright 注册验证码是：${code}\n\n验证码 10 分钟内有效，仅用于注册，重发后旧码失效。\n若非本人操作，请忽略此邮件。` }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('mail_timeout')), 30000) }),
      ])
      if (!result.accepted.some((recipient: unknown) => typeof recipient === 'string' && normalizeEmail(recipient) === email)) throw new Error('mail_rejected')
    } finally { if (timer) clearTimeout(timer) }
  } }
}
