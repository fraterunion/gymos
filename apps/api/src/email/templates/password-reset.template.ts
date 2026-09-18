import type { ResolvedEmailBranding } from '../email-branding';

/**
 * Password reset email content. Pure: branding in, subject/html/text out — no studio name,
 * colour or URL is hardcoded. Copy lives in a per-locale dictionary so another language is
 * a data change, not a template rewrite; 'es' is the default because that is what the
 * customer-facing apps currently speak.
 */

export type EmailLocale = 'es' | 'en';

export type PasswordResetEmailInput = {
  branding: ResolvedEmailBranding;
  resetUrl: string;
  expiresInMinutes: number;
  firstName?: string | null;
  locale?: EmailLocale;
};

export type RenderedEmail = { subject: string; html: string; text: string };

const COPY: Record<EmailLocale, (b: { brand: string; minutes: number; name: string | null }) => {
  subject: string;
  greeting: string;
  intro: string;
  cta: string;
  fallback: string;
  expiry: string;
  ignore: string;
  signature: string;
}> = {
  es: ({ brand, minutes, name }) => ({
    subject: `Restablece tu contraseña de ${brand}`,
    greeting: name ? `Hola ${name},` : 'Hola,',
    intro: `Recibimos una solicitud para restablecer la contraseña de tu cuenta de ${brand}.`,
    cta: 'Restablecer contraseña',
    fallback: 'Si el botón no funciona, copia y pega este enlace en tu navegador:',
    expiry: `Este enlace caduca en ${minutes} minutos y solo puede usarse una vez.`,
    ignore:
      'Si no solicitaste este cambio, puedes ignorar este correo: tu contraseña actual seguirá funcionando.',
    signature: `Equipo de ${brand}`,
  }),
  en: ({ brand, minutes, name }) => ({
    subject: `Reset your ${brand} password`,
    greeting: name ? `Hi ${name},` : 'Hi,',
    intro: `We received a request to reset the password for your ${brand} account.`,
    cta: 'Reset password',
    fallback: "If the button doesn't work, copy and paste this link into your browser:",
    expiry: `This link expires in ${minutes} minutes and can only be used once.`,
    ignore:
      'If you did not request this, you can ignore this email — your current password will keep working.',
    signature: `The ${brand} team`,
  }),
};

const DEFAULT_ACCENT = '#111111';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderPasswordResetEmail(input: PasswordResetEmailInput): RenderedEmail {
  const locale = input.locale ?? 'es';
  const brand = input.branding.displayName;
  const copy = COPY[locale]({
    brand,
    minutes: input.expiresInMinutes,
    name: input.firstName?.trim() || null,
  });

  const accent = input.branding.primaryColor ?? DEFAULT_ACCENT;
  const logo = input.branding.logoUrl;
  const support = input.branding.supportEmail;

  const safeUrl = escapeHtml(input.resetUrl);
  const header = logo
    ? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(brand)}" height="48" style="max-height:48px;border:0;display:block;margin:0 auto 24px" />`
    : `<div style="font-size:20px;font-weight:700;text-align:center;margin:0 0 24px;color:#111">${escapeHtml(brand)}</div>`;

  const supportBlock = support
    ? `<p style="margin:24px 0 0;font-size:13px;color:#6b7280">${escapeHtml(support)}</p>`
    : '';

  const html = `<!doctype html>
<html lang="${locale}">
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 16px">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;padding:32px">
          <tr>
            <td>
              ${header}
              <p style="margin:0 0 16px;font-size:16px;color:#111">${escapeHtml(copy.greeting)}</p>
              <p style="margin:0 0 24px;font-size:15px;line-height:22px;color:#374151">${escapeHtml(copy.intro)}</p>
              <p style="margin:0 0 28px;text-align:center">
                <a href="${safeUrl}" style="display:inline-block;padding:14px 28px;border-radius:12px;background:${escapeHtml(accent)};color:#ffffff;font-size:15px;font-weight:600;text-decoration:none">${escapeHtml(copy.cta)}</a>
              </p>
              <p style="margin:0 0 8px;font-size:13px;color:#6b7280">${escapeHtml(copy.fallback)}</p>
              <p style="margin:0 0 24px;font-size:13px;word-break:break-all"><a href="${safeUrl}" style="color:${escapeHtml(accent)}">${safeUrl}</a></p>
              <p style="margin:0 0 8px;font-size:13px;color:#6b7280">${escapeHtml(copy.expiry)}</p>
              <p style="margin:0;font-size:13px;color:#6b7280">${escapeHtml(copy.ignore)}</p>
              <hr style="border:0;border-top:1px solid #e5e7eb;margin:28px 0" />
              <p style="margin:0;font-size:13px;color:#6b7280">${escapeHtml(copy.signature)}</p>
              ${supportBlock}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = [
    copy.greeting,
    '',
    copy.intro,
    '',
    input.resetUrl,
    '',
    copy.expiry,
    copy.ignore,
    '',
    copy.signature,
    ...(support ? [support] : []),
  ].join('\n');

  return { subject: copy.subject, html, text };
}
