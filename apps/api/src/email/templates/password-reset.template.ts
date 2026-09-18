import type { ResolvedEmailBranding } from '../email-branding';

/**
 * Password reset email. Pure: branding in, subject/html/text out — no studio name, colour
 * or URL is hardcoded. Copy lives in a per-locale dictionary so another language is a data
 * change, not a template rewrite; 'es' is the default because that is what the
 * customer-facing apps currently speak.
 *
 * Design constraints that shaped this markup:
 *  · Transactional, not marketing: one action, no tracking pixel, no external script.
 *  · Table-based layout with inline styles — Outlook and Gmail ignore <style> blocks and
 *    modern CSS, so anything structural has to be attributes and inline declarations.
 *  · IMAGES OFF IS THE DEFAULT for a first-time sender in Gmail. The brand block therefore
 *    renders the studio's NAME as real text on the brand colour, with the logo layered as
 *    an enhancement — the email is complete and on-brand with every image blocked.
 *  · The brand band uses the studio's own primary colour, which is the surface its logo was
 *    designed for. A wordmark drawn in white on transparent stays legible there without the
 *    template knowing anything about any particular studio.
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

const COPY: Record<
  EmailLocale,
  (b: { brand: string; minutes: number; name: string | null }) => {
    subject: string;
    preheader: string;
    greeting: string;
    intro: string;
    cta: string;
    fallbackLabel: string;
    expiry: string;
    ignore: string;
    signature: string;
  }
> = {
  es: ({ brand, minutes, name }) => ({
    subject: `Restablece tu contraseña de ${brand}`,
    preheader: `Enlace válido por ${minutes} minutos.`,
    greeting: name ? `Hola ${name},` : 'Hola,',
    intro: `Recibimos una solicitud para restablecer la contraseña de tu cuenta de ${brand}.`,
    cta: 'Restablecer contraseña',
    fallbackLabel: 'Si el botón no funciona, copia y pega este enlace en tu navegador:',
    expiry: `Este enlace expirará en ${minutes} minutos y solo puede utilizarse una vez.`,
    ignore:
      'Si tú no solicitaste este cambio, puedes ignorar este correo. Tu contraseña seguirá siendo la misma.',
    signature: brand,
  }),
  en: ({ brand, minutes, name }) => ({
    subject: `Reset your ${brand} password`,
    preheader: `Link valid for ${minutes} minutes.`,
    greeting: name ? `Hi ${name},` : 'Hi,',
    intro: `We received a request to reset the password for your ${brand} account.`,
    cta: 'Reset password',
    fallbackLabel: "If the button doesn't work, copy and paste this link into your browser:",
    expiry: `This link expires in ${minutes} minutes and can only be used once.`,
    ignore:
      'If you did not request this, you can ignore this email. Your password will stay the same.',
    signature: brand,
  }),
};

/** Deep neutral used when a studio has published no colour. */
const DEFAULT_BRAND_SURFACE = '#0A0A0A';
const INK = '#18181B';
const MUTED = '#71717A';
const HAIRLINE = '#E4E4E7';
const PAGE = '#F4F4F5';

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

  const surface = input.branding.primaryColor ?? DEFAULT_BRAND_SURFACE;
  const logo = input.branding.logoUrl;
  const support = input.branding.supportEmail;

  const safeBrand = escapeHtml(brand);
  const safeSurface = escapeHtml(surface);
  const safeUrl = escapeHtml(input.resetUrl);

  // Wordmark as text, always present; the logo sits above it only when one is published.
  // With images blocked the band still shows the brand colour and the studio's name.
  const logoBlock = logo
    ? `<img src="${escapeHtml(logo)}" alt="${safeBrand}" height="36" style="display:block;margin:0 auto 14px;max-height:36px;width:auto;border:0;outline:none;text-decoration:none" />`
    : '';

  const supportBlock = support
    ? `<div style="margin:6px 0 0"><a href="mailto:${escapeHtml(support)}" style="color:${MUTED};font-size:13px;text-decoration:none">${escapeHtml(support)}</a></div>`
    : '';

  const html = `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<title>${escapeHtml(copy.subject)}</title>
</head>
<body style="margin:0;padding:0;background:${PAGE};-webkit-font-smoothing:antialiased">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(copy.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE};padding:32px 12px">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#FFFFFF;border:1px solid ${HAIRLINE};border-radius:14px;overflow:hidden">

        <tr>
          <td align="center" style="background:${safeSurface};padding:34px 24px">
            ${logoBlock}
            <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#FFFFFF">${safeBrand}</div>
          </td>
        </tr>

        <tr>
          <td style="padding:40px 40px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
            <p style="margin:0 0 18px;font-size:17px;line-height:26px;color:${INK}">${escapeHtml(copy.greeting)}</p>
            <p style="margin:0 0 32px;font-size:15px;line-height:24px;color:${INK}">${escapeHtml(copy.intro)}</p>

            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
              <tr>
                <td align="center">
                  <a href="${safeUrl}" style="display:block;padding:16px 24px;background:${safeSurface};color:#FFFFFF;font-size:15px;font-weight:600;letter-spacing:0.4px;text-decoration:none;border-radius:10px;text-align:center">${escapeHtml(copy.cta)}</a>
                </td>
              </tr>
            </table>

            <p style="margin:28px 0 0;font-size:13px;line-height:20px;color:${MUTED}">${escapeHtml(copy.expiry)}</p>
            <p style="margin:10px 0 0;font-size:13px;line-height:20px;color:${MUTED}">${escapeHtml(copy.ignore)}</p>

            <hr style="border:0;border-top:1px solid ${HAIRLINE};margin:28px 0 0" />

            <p style="margin:20px 0 6px;font-size:12px;line-height:18px;color:${MUTED}">${escapeHtml(copy.fallbackLabel)}</p>
            <p style="margin:0;font-size:12px;line-height:18px;word-break:break-all"><a href="${safeUrl}" style="color:${MUTED};text-decoration:underline">${safeUrl}</a></p>
          </td>
        </tr>

        <tr>
          <td align="center" style="padding:22px 24px 28px;border-top:1px solid ${HAIRLINE};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
            <div style="font-size:13px;font-weight:600;color:${INK}">${escapeHtml(copy.signature)}</div>
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
    brand.toUpperCase(),
    '',
    copy.greeting,
    '',
    copy.intro,
    '',
    copy.cta.toUpperCase() + ':',
    input.resetUrl,
    '',
    copy.expiry,
    copy.ignore,
    '',
    '—',
    brand,
    ...(support ? [support] : []),
  ].join('\n');

  return { subject: copy.subject, html, text };
}
