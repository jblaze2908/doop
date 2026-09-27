import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'

/**
 * Outbound email over SMTP (works with any provider — Resend, Postmark, SES,
 * a local relay). Entirely optional: with SMTP_HOST unset, emails are printed
 * to the server log instead, so verification and password-reset links remain
 * usable in development and small self-hosts without an email provider.
 */

export const mailerConfigured = !!process.env.SMTP_HOST

let transport: Transporter | null = null
if (mailerConfigured) {
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    /* 465 = implicit TLS; anything else negotiates STARTTLS */
    secure: process.env.SMTP_SECURE === 'true' || process.env.SMTP_PORT === '465',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  })
}

export async function sendMail(opts: { to: string; subject: string; text: string }) {
  if (!transport) {
    console.log(
      `[mail] SMTP not configured — logging instead\n  to: ${opts.to}\n  subject: ${opts.subject}\n  ${opts.text.replace(/\n/g, '\n  ')}`,
    )
    return
  }
  await transport.sendMail({
    from: process.env.EMAIL_FROM || 'draft <no-reply@localhost>',
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
  })
}
