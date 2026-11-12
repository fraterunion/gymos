import { readFileSync } from 'node:fs';
import { resolveEmailBranding, type PlatformEmailDefaults, type StudioBrandingRow } from '../email/email-branding';
import { studioEmailLogo } from '../email/studio-email-logos';
import { renderCampaignEmail } from './campaign-email.template';

const DEFAULTS: PlatformEmailDefaults = {
  platformName: 'GymOS',
  fromEmail: 'no-reply@platform.test',
  fromName: null,
  supportEmail: null,
  resetUrlBase: 'https://app.platform.test',
};

const UNSUBSCRIBE = 'https://api.platform.test/api/v1/email/unsubscribe?token=signed.token';

function studio(overrides: Partial<StudioBrandingRow> = {}): StudioBrandingRow {
  return {
    id: 'studio-1',
    slug: 'north-strength',
    name: 'North Strength Co',
    appName: null,
    appDisplayName: null,
    brandPrimaryColor: null,
    primaryColor: null,
    brandLogoUrl: null,
    logoUrl: null,
    supportEmail: null,
    supportPhone: null,
    ...overrides,
  };
}

/** The production ARES studio row as of this change (support phone is still a placeholder). */
const ARES_ROW = studio({
  id: 'studio-ares',
  slug: 'ares-fitness',
  name: 'Ares Training Club',
  appName: 'Ares Training Club',
  appDisplayName: 'Ares Training Club',
  brandPrimaryColor: '#0f172a',
  logoUrl: 'https://www.arestrainingclub.com/ares-wordmark.png',
  supportEmail: 'support@arestrainingclub.com',
  supportPhone: '+52 55 0000 0000',
  privacyUrl: 'https://www.arestrainingclub.com/privacy',
  websiteUrl: null,
  instagramHandle: null,
  address: null,
});

function render(row: StudioBrandingRow, overrides: Partial<Parameters<typeof renderCampaignEmail>[0]> = {}) {
  const branding = resolveEmailBranding(row, DEFAULTS);
  return renderCampaignEmail({
    branding,
    senderName: branding.from.name,
    logo: studioEmailLogo(row.slug),
    subject: 'Nuevos horarios de diciembre',
    bodyText: 'Hola equipo:\n\nAjustamos los horarios.\nReserva en https://reservas.studio.test/clases.',
    unsubscribeUrl: UNSUBSCRIBE,
    ...overrides,
  });
}

describe('campaign email', () => {
  it('gives ARES its white wordmark from the public site on the graphite header', () => {
    const mail = render(ARES_ROW, { senderName: 'ARES Training Club' });
    expect(mail.html).toMatch(
      /<img src="https:\/\/www\.arestrainingclub\.com\/ares-wordmark\.png" width="208" height="52" alt="Ares Training Club"/,
    );
    expect(mail.html).toMatch(/class="em-header"[^>]*background:#0A0A0A;/);
    // Production ARES brandPrimaryColor (#0f172a) is too dark for the graphite header stripe.
    expect(mail.html).not.toContain('border-top:3px solid #0f172a');
    expect(mail.html).toContain('>ARES Training Club</p>');
    expect(mail.html).toContain('href="mailto:support@arestrainingclub.com"');
    expect(mail.html).toContain('href="https://www.arestrainingclub.com/privacy" target="_blank"');
  });

  it('never prints the studio phone, which may still be a placeholder', () => {
    const mail = render(ARES_ROW);
    expect(mail.html).not.toContain('+52 55');
    expect(mail.text).not.toContain('+52 55');
  });

  it('gives a studio without a registered email logo its name as type, never its app logo URL', () => {
    const mail = render(
      studio({
        slug: 'pilates-toluca',
        appName: 'Pilates Toluca',
        brandPrimaryColor: '#3d5a40',
        brandLogoUrl: 'https://images.unsplash.com/photo-1?w=400',
      }),
    );
    expect(mail.html).not.toContain('<img');
    expect(mail.html).not.toContain('unsplash');
    expect(mail.html).toMatch(/color:#FFFFFF">Pilates Toluca<\/p>/);
    expect(mail.html).toContain('border-top:3px solid #3d5a40;');
  });

  it('uses the subject as headline and title, and the message opening as the inbox preheader', () => {
    const mail = render(ARES_ROW);
    expect(mail.subject).toBe('Nuevos horarios de diciembre');
    expect(mail.html).toContain('<title>Nuevos horarios de diciembre</title>');
    expect(mail.html).toMatch(/<h1 class="em-headline"[^>]*>Nuevos horarios de diciembre<\/h1>/);
    expect(mail.html).toMatch(/mso-hide:all">Hola equipo: Ajustamos los horarios\. Reserva en https:\/\/reservas\.studio\.test\/clases\./);
  });

  it('keeps admin text escaped, paragraphs split and URLs clickable', () => {
    const mail = render(ARES_ROW, { subject: 'Aviso <b>', bodyText: 'Hola <script>alert(1)</script>\n\nVisita https://reservas.studio.test/clases.' });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).not.toContain('<b>');
    expect(mail.html).toContain('Hola &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(mail.html).toContain('<h1 class="em-headline"');
    expect(mail.html).toContain('Aviso &lt;b&gt;</h1>');
    expect(mail.html).toContain('href="https://reservas.studio.test/clases" target="_blank"');
  });

  it('keeps the per-recipient unsubscribe link and membership notice in both parts', () => {
    const mail = render(ARES_ROW);
    expect(mail.html).toContain('href="https://api.platform.test/api/v1/email/unsubscribe?token=signed.token" target="_blank"');
    expect(mail.html).toContain('>Cancelar suscripción</a>');
    expect(mail.html).toContain('Recibes este mensaje porque tienes una membresía en Ares Training Club.');
    expect(mail.text).toContain(`Cancelar suscripción: ${UNSUBSCRIBE}`);
    expect(mail.text).toContain('Recibes este mensaje porque tienes una membresía en Ares Training Club.');
  });

  it('keeps a plain-text part with the message, signature and contact, and no markup', () => {
    const mail = render(ARES_ROW, { senderName: 'ARES Training Club' });
    expect(mail.text.startsWith('Hola equipo:\n\nAjustamos los horarios.')).toBe(true);
    expect(mail.text).toContain('—\nARES Training Club\nsupport@arestrainingclub.com\nAviso de privacidad: https://www.arestrainingclub.com/privacy');
    expect(mail.text).not.toMatch(/<[a-z]/i);
  });

  it('lists website, Instagram and address when the studio publishes them, sanitised', () => {
    const mail = render(
      studio({
        supportEmail: 'not-an-email',
        websiteUrl: 'https://www.north.test',
        instagramHandle: '@north.strength',
        address: 'Calle 1\n  Col. Centro',
      }),
    );
    expect(mail.html).not.toContain('not-an-email');
    expect(mail.html).toContain('href="https://www.north.test" target="_blank" style="color:#6B6B6B;text-decoration:underline">north.test</a>');
    expect(mail.html).toContain('href="https://www.instagram.com/north.strength/"');
    expect(mail.html).toContain('>@north.strength</a>');
    expect(mail.html).toContain('>Calle 1 Col. Centro</p>');
    expect(mail.text).toContain('Instagram: @north.strength');
  });

  it('keeps the shared campaign template free of any studio identity', () => {
    const source = readFileSync(`${__dirname}/campaign-email.template.ts`, 'utf8');
    expect(source).not.toMatch(/ares/i);
    expect(source).not.toMatch(/fraterunion/i);
  });

  it('renders the ARES campaign byte-for-byte as reviewed', () => {
    const mail = render(ARES_ROW, { senderName: 'ARES Training Club' });
    expect(mail.html).toMatchSnapshot();
    expect(mail.text).toMatchSnapshot();
  });
});
