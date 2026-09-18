import { readFileSync } from 'node:fs';
import {
  buildResetUrl,
  resolveEmailBranding,
  safeHexColor,
  safeHttpUrl,
  selectBrandingStudio,
  type PlatformEmailDefaults,
  type StudioBrandingRow,
} from './email-branding';
import { renderPasswordResetEmail } from './templates/password-reset.template';

const DEFAULTS: PlatformEmailDefaults = {
  platformName: 'GymOS',
  fromEmail: 'no-reply@gymos.app',
  fromName: null,
  supportEmail: null,
  resetUrlBase: 'https://app.gymos.test',
};

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

describe('white-label email branding', () => {
  it('uses neutral platform branding when the user has no studio', () => {
    const b = resolveEmailBranding(null, DEFAULTS);
    expect(b.displayName).toBe('GymOS');
    expect(b.studioId).toBeNull();
    expect(b.from.email).toBe('no-reply@gymos.app');
  });

  it('prefers desk-era branding columns over legacy ones, matching BrandingService', () => {
    const b = resolveEmailBranding(
      studio({
        appName: 'Legacy App Name',
        appDisplayName: 'Desk App Name',
        brandPrimaryColor: '#111111',
        primaryColor: '#22AA55',
        brandLogoUrl: 'https://cdn.test/legacy.png',
        logoUrl: 'https://cdn.test/desk.png',
      }),
      DEFAULTS,
    );
    expect(b.displayName).toBe('Desk App Name');
    expect(b.primaryColor).toBe('#22AA55');
    expect(b.logoUrl).toBe('https://cdn.test/desk.png');
  });

  it('falls back through appName to the studio name', () => {
    expect(resolveEmailBranding(studio(), DEFAULTS).displayName).toBe('North Strength Co');
    expect(resolveEmailBranding(studio({ appName: 'Just App' }), DEFAULTS).displayName).toBe('Just App');
  });

  it('white-labels the sender display name but keeps the platform envelope address', () => {
    const b = resolveEmailBranding(studio({ appDisplayName: 'Tiny Gym' }), DEFAULTS);
    expect(b.from).toEqual({ email: 'no-reply@gymos.app', name: 'Tiny Gym' });
  });

  it('drops unsafe colours and non-http logos so studio data cannot inject markup', () => {
    const b = resolveEmailBranding(
      studio({ primaryColor: 'red;}</style><script>', logoUrl: 'javascript:alert(1)' }),
      DEFAULTS,
    );
    expect(b.primaryColor).toBeNull();
    expect(b.logoUrl).toBeNull();
    expect(safeHexColor('#abc')).toBe('#abc');
    expect(safeHexColor('#zzzzzz')).toBeNull();
    expect(safeHttpUrl('https://ok.test/a.png')).toBe('https://ok.test/a.png');
    expect(safeHttpUrl('data:image/png;base64,AAA')).toBeNull();
  });

  it('contains no hardcoded studio identity anywhere in the shared modules', () => {
    // Guards the platform boundary: the shared service must never mention one customer.
    const sources = [
      readFileSync(`${__dirname}/email-branding.ts`, 'utf8'),
      readFileSync(`${__dirname}/transactional-email.service.ts`, 'utf8'),
      readFileSync(`${__dirname}/templates/password-reset.template.ts`, 'utf8'),
    ].join('\n');
    expect(sources).not.toMatch(/ares/i);
    expect(sources).not.toMatch(/arestrainingclub/i);
    expect(sources).not.toMatch(/fraterunion/i);
  });
});

describe('multi-studio branding determinism', () => {
  const older = { studioId: 'studio-old', createdAt: new Date('2024-01-01T00:00:00Z') };
  const newer = { studioId: 'studio-new', createdAt: new Date('2025-01-01T00:00:00Z') };

  it('returns null when the user belongs to no studio', () => {
    expect(selectBrandingStudio([], null)).toBeNull();
  });

  it('honours a hint only when the user actually belongs to that studio', () => {
    expect(selectBrandingStudio([older, newer], 'studio-new')).toBe('studio-new');
    // A studio the user is NOT part of can never brand (or confirm) their mail.
    expect(selectBrandingStudio([older, newer], 'studio-unrelated')).toBe('studio-old');
  });

  it('is stable and order-independent without a hint (oldest membership wins)', () => {
    expect(selectBrandingStudio([newer, older], null)).toBe('studio-old');
    expect(selectBrandingStudio([older, newer], null)).toBe('studio-old');
  });

  it('breaks exact createdAt ties by studio id so repeated resets look identical', () => {
    const a = { studioId: 'aaa', createdAt: new Date('2024-01-01T00:00:00Z') };
    const b = { studioId: 'bbb', createdAt: new Date('2024-01-01T00:00:00Z') };
    expect(selectBrandingStudio([b, a], null)).toBe('aaa');
    expect(selectBrandingStudio([a, b], null)).toBe('aaa');
  });
});

describe('reset URL construction', () => {
  it('encodes the token and carries the studio slug for page branding', () => {
    const url = buildResetUrl('https://app.gymos.test/', 'tok en+/=', 'north-strength');
    expect(url.startsWith('https://app.gymos.test/reset-password?')).toBe(true);
    expect(url).toContain('token=tok+en%2B%2F%3D');
    expect(url).toContain('studio=north-strength');
  });

  it('omits the studio parameter for platform-only accounts', () => {
    expect(buildResetUrl('https://app.gymos.test', 'abc', null)).toBe(
      'https://app.gymos.test/reset-password?token=abc',
    );
  });
});

describe('password reset email rendering', () => {
  const branding = resolveEmailBranding(
    studio({ appDisplayName: 'Tiny Gym', primaryColor: '#22AA55', supportEmail: 'hola@tiny.test' }),
    DEFAULTS,
  );

  it('renders studio-branded Spanish copy by default', () => {
    const mail = renderPasswordResetEmail({
      branding,
      resetUrl: 'https://app.gymos.test/reset-password?token=abc',
      expiresInMinutes: 30,
      firstName: 'Ana',
    });
    expect(mail.subject).toBe('Restablece tu contraseña de Tiny Gym');
    expect(mail.html).toContain('Hola Ana');
    expect(mail.html).toContain('#22AA55');
    expect(mail.html).toContain('https://app.gymos.test/reset-password?token=abc');
    expect(mail.text).toContain('30 minutos');
    expect(mail.html).toContain('hola@tiny.test');
  });

  it('supports another locale without changing the template', () => {
    const mail = renderPasswordResetEmail({
      branding,
      resetUrl: 'https://x.test/r?token=1',
      expiresInMinutes: 30,
      locale: 'en',
    });
    expect(mail.subject).toBe('Reset your Tiny Gym password');
    expect(mail.html).toContain('Reset password');
  });

  it('escapes studio-controlled text so branding cannot inject HTML', () => {
    const hostile = resolveEmailBranding(studio({ appDisplayName: '<script>x</script>' }), DEFAULTS);
    const mail = renderPasswordResetEmail({
      branding: hostile,
      resetUrl: 'https://x.test/r?token=1',
      expiresInMinutes: 30,
    });
    expect(mail.html).not.toContain('<script>x</script>');
    expect(mail.html).toContain('&lt;script&gt;');
  });

  it('survives images being blocked: brand name and colour are real text/markup', () => {
    const mail = renderPasswordResetEmail({
      branding,
      resetUrl: 'https://x.test/r?token=1',
      expiresInMinutes: 30,
    });
    // Gmail blocks remote images for unknown senders — the band must still identify the
    // studio without loading anything.
    const withoutImages = mail.html.replace(/<img[^>]*>/g, '');
    expect(withoutImages).toContain('Tiny Gym');
    expect(withoutImages).toContain('#22AA55');
  });

  it('gives the logo an alt of the studio name so blocked images still read as the brand', () => {
    const withLogo = resolveEmailBranding(
      studio({ appDisplayName: 'Tiny Gym', logoUrl: 'https://cdn.test/logo.png' }),
      DEFAULTS,
    );
    const mail = renderPasswordResetEmail({
      branding: withLogo,
      resetUrl: 'https://x.test/r?token=1',
      expiresInMinutes: 30,
    });
    expect(mail.html).toMatch(/<img[^>]+alt="Tiny Gym"/);
  });

  it('carries no tracking pixel, script or external stylesheet', () => {
    const mail = renderPasswordResetEmail({
      branding,
      resetUrl: 'https://x.test/r?token=1',
      expiresInMinutes: 30,
    });
    expect(mail.html).not.toMatch(/<script/i);
    expect(mail.html).not.toMatch(/<link[^>]+stylesheet/i);
    // A 1x1 beacon would be the classic tracking pattern.
    expect(mail.html).not.toMatch(/width="1"|height="1"/);
  });

  it('keeps a plain-text alternative carrying the link and the brand', () => {
    const mail = renderPasswordResetEmail({
      branding,
      resetUrl: 'https://x.test/r?token=abc',
      expiresInMinutes: 30,
      firstName: 'Ana',
    });
    expect(mail.text).toContain('TINY GYM');
    expect(mail.text).toContain('Hola Ana,');
    expect(mail.text).toContain('https://x.test/r?token=abc');
    expect(mail.text).not.toMatch(/<[a-z]/i); // no markup leaked into the text part
  });

  it('escapes a hostile brand colour instead of letting it break out of the style attribute', () => {
    const hostile = resolveEmailBranding(
      studio({ appDisplayName: 'Tiny Gym', primaryColor: '#22AA55' }),
      DEFAULTS,
    );
    // safeHexColor already rejects non-hex, so the surface can only ever be a hex literal.
    const mail = renderPasswordResetEmail({
      branding: { ...hostile, primaryColor: '" onload="alert(1)' },
      resetUrl: 'https://x.test/r?token=1',
      expiresInMinutes: 30,
    });
    expect(mail.html).not.toContain('onload="alert(1)"');
    expect(mail.html).toContain('&quot; onload=&quot;alert(1)');
  });

  it('never states whether the account exists', () => {
    const mail = renderPasswordResetEmail({
      branding,
      resetUrl: 'https://x.test/r?token=1',
      expiresInMinutes: 30,
    });
    expect(mail.text).toContain('ignorar este correo');
  });
});
