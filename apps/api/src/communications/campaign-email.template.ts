import type { ResolvedEmailBranding } from '../email/email-branding';
import {
  emailPreheader,
  plainTextToEmailHtml,
  renderBrandedEmailLayout,
  type EmailImage,
  type EmailLink,
} from '../email/templates/branded-email-layout';

export type RenderedCampaignEmail = { subject: string; html: string; text: string };

const SUBJECT_MAX = 200;
const BODY_MAX = 10_000;
const EMAIL = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

export function normalizeCampaignContent(subject: string, bodyText: string): { subject: string; bodyText: string } {
  const cleanSubject = subject.replace(/[\r\n]+/g, ' ').trim();
  const cleanBody = bodyText.split('\u0000').join('').trim();
  if (!cleanSubject || cleanSubject.length > SUBJECT_MAX) {
    throw new Error('El asunto debe tener entre 1 y 200 caracteres.');
  }
  if (!cleanBody || cleanBody.length > BODY_MAX) {
    throw new Error('El mensaje debe tener entre 1 y 10000 caracteres.');
  }
  return { subject: cleanSubject, bodyText: cleanBody };
}

function websiteLabel(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Plain text from the admin becomes escaped HTML inside the studio's branded layout. No raw
 * markup is trusted. The subject doubles as the headline.
 */
export function renderCampaignEmail(input: {
  branding: ResolvedEmailBranding;
  /** Display name of the From header; the footer signs with the same name. */
  senderName: string;
  /** A logo verified for the dark header (see studio-email-logos.ts), or null for a name lockup. */
  logo: EmailImage | null;
  subject: string;
  bodyText: string;
  unsubscribeUrl: string;
}): RenderedCampaignEmail {
  const { branding } = input;
  const supportEmail = branding.supportEmail && EMAIL.test(branding.supportEmail) ? branding.supportEmail : null;
  const instagram = branding.instagramHandle;
  const contact: EmailLink[] = [
    ...(supportEmail ? [{ label: supportEmail, url: `mailto:${supportEmail}` }] : []),
    ...(branding.websiteUrl ? [{ label: websiteLabel(branding.websiteUrl), url: branding.websiteUrl }] : []),
    ...(instagram ? [{ label: `@${instagram}`, url: `https://www.instagram.com/${instagram}/` }] : []),
    ...(branding.privacyUrl ? [{ label: 'Aviso de privacidad', url: branding.privacyUrl }] : []),
  ];
  const notice = `Recibes este mensaje porque tienes una membresía en ${branding.displayName}.`;

  const html = renderBrandedEmailLayout({
    locale: 'es',
    title: input.subject,
    preheader: emailPreheader(input.bodyText),
    brand: { name: branding.displayName, logo: input.logo, accentColor: branding.primaryColor },
    headline: input.subject,
    bodyHtml: plainTextToEmailHtml(input.bodyText),
    footer: {
      senderName: input.senderName,
      links: contact,
      address: branding.address,
      notice,
      unsubscribe: { label: 'Cancelar suscripción', url: input.unsubscribeUrl },
    },
  });

  const text = [
    input.bodyText,
    '',
    '—',
    input.senderName,
    ...(supportEmail ? [supportEmail] : []),
    ...(branding.websiteUrl ? [branding.websiteUrl] : []),
    ...(instagram ? [`Instagram: @${instagram}`] : []),
    ...(branding.privacyUrl ? [`Aviso de privacidad: ${branding.privacyUrl}`] : []),
    ...(branding.address ? [branding.address] : []),
    '',
    notice,
    `Cancelar suscripción: ${input.unsubscribeUrl}`,
  ].join('\n');

  return { subject: input.subject, html, text };
}
