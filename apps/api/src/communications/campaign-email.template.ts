import { escapeHtml } from '../email/templates/password-reset.template';

export type RenderedCampaignEmail = { subject: string; html: string; text: string };

const SUBJECT_MAX = 200;
const BODY_MAX = 10_000;

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

/** Plain text from the admin becomes escaped HTML. No raw markup is trusted. */
export function renderCampaignEmail(input: {
  studioName: string;
  subject: string;
  bodyText: string;
  unsubscribeUrl: string;
}): RenderedCampaignEmail {
  const paragraphs = input.bodyText
    .split(/\n{2,}/)
    .map((block) => escapeHtml(block).replace(/\n/g, '<br>'));
  const htmlBody = paragraphs
    .map((block) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.5;color:#18181b;">${block}</p>`)
    .join('');
  const html = `<!doctype html><html><body style="margin:0;background:#f4f4f5;padding:24px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:12px;padding:28px;">
<tr><td style="font-family:Georgia,serif;font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#71717a;">${escapeHtml(input.studioName)}</td></tr>
<tr><td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding-top:16px;">${htmlBody}
<p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#71717a;">Recibes este mensaje porque tienes una membresía en ${escapeHtml(input.studioName)}.
<a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#71717a;">Cancelar suscripción</a></p>
</td></tr></table></td></tr></table></body></html>`;
  const text = `${input.bodyText}\n\n—\nRecibes este mensaje porque tienes una membresía en ${input.studioName}.\nCancelar suscripción: ${input.unsubscribeUrl}`;
  return { subject: input.subject, html, text };
}
