import {
  accentOnDarkSurface,
  emailPreheader,
  plainTextToEmailHtml,
  renderBrandedEmailLayout,
  type BrandedEmailLayoutInput,
} from './branded-email-layout';

const LOGO = { url: 'https://cdn.studio.test/wordmark.png', width: 800, height: 200 };

function layout(overrides: Partial<BrandedEmailLayoutInput> = {}): string {
  return renderBrandedEmailLayout({
    title: 'Horarios',
    preheader: 'Nuevos horarios',
    brand: { name: 'North Strength', logo: null, accentColor: null },
    headline: 'Horarios de diciembre',
    bodyHtml: plainTextToEmailHtml('Hola equipo'),
    footer: {
      senderName: 'North Strength',
      links: [{ label: 'hola@north.test', url: 'mailto:hola@north.test' }],
      notice: 'Recibes este mensaje porque eres miembro.',
      unsubscribe: { label: 'Cancelar suscripción', url: 'https://api.test/unsubscribe?token=a&b=c' },
    },
    ...overrides,
  });
}

describe('branded email layout', () => {
  it('is a table layout with a fixed 600px column, also for Outlook', () => {
    const html = layout();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="es"');
    expect(html).toMatch(/<table role="presentation" class="em-card"[^>]*max-width:600px/);
    expect(html).toContain('<!--[if mso]><table role="presentation" width="600"');
    expect(html).toContain('@media only screen and (max-width:620px)');
  });

  it('sizes a logo from its intrinsic dimensions with HTML attributes and carries the name as alt text', () => {
    const html = layout({ brand: { name: 'North Strength', logo: LOGO } });
    expect(html).toMatch(/<img src="https:\/\/cdn\.studio\.test\/wordmark\.png" width="208" height="52" alt="North Strength"/);
    // One lockup: with a logo the name is not printed again in the header.
    const header = html.slice(html.indexOf('class="em-header"'), html.indexOf('class="em-body"'));
    expect(header.match(/North Strength/g)).toHaveLength(1);
  });

  it('falls back to the name as text for missing, non-HTTPS or unsized logos', () => {
    for (const logo of [
      null,
      { ...LOGO, url: 'http://cdn.studio.test/wordmark.png' },
      { ...LOGO, url: 'javascript:alert(1)' },
      { ...LOGO, width: 0 },
      { ...LOGO, height: Number.NaN },
    ]) {
      const html = layout({ brand: { name: 'North Strength', logo } });
      expect(html).not.toContain('<img');
      expect(html).toMatch(/text-transform:uppercase;color:#FFFFFF">North Strength<\/p>/);
    }
  });

  it('keeps the graphite header for every studio and uses a visible brand colour only as a 3px accent', () => {
    const html = layout({ brand: { name: 'North Strength', accentColor: '#22AA55' } });
    expect(html).toMatch(/class="em-header"[^>]*background:#0A0A0A;border-top:3px solid #22AA55;/);
    expect(html).toContain('border-bottom:1px solid #1A1A1A;');
    // Near-black brand colours are invisible on graphite — omit rather than draw a phantom line.
    expect(layout({ brand: { name: 'North Strength', accentColor: '#0f172a' } })).not.toContain('border-top:3px');
    const hostile = layout({ brand: { name: 'North Strength', accentColor: 'red;}</style><script>' } });
    expect(hostile).not.toContain('border-top:3px');
    expect(hostile).not.toMatch(/<script/i);
  });

  it('draws a short ink rule under the headline', () => {
    const html = layout();
    expect(html).toContain('class="em-rule"');
    expect(html).toMatch(/class="em-headline"[^>]*>Horarios de diciembre<\/h1>/);
    expect(layout({ headline: null })).not.toContain('class="em-rule"');
  });

  it('exposes accentOnDarkSurface for callers that need the same visibility rule', () => {
    expect(accentOnDarkSurface('#22AA55')).toBe('#22AA55');
    expect(accentOnDarkSurface('#3d5a40')).toBe('#3d5a40');
    expect(accentOnDarkSurface('#0f172a')).toBeNull();
    expect(accentOnDarkSurface('#0A0A0A')).toBeNull();
    expect(accentOnDarkSurface('not-a-color')).toBeNull();
  });

  it('hides the preheader and pads it so body text does not leak into the inbox preview', () => {
    const html = layout({ preheader: 'Clases <nuevas>' });
    expect(html).toMatch(/<div style="display:none;[^"]*mso-hide:all">Clases &lt;nuevas&gt;(&#847;&zwnj;&nbsp;)+<\/div>/);
    expect(layout({ preheader: '  ' })).not.toContain('mso-hide:all');
  });

  it('renders an optional bulletproof CTA and drops one with an unsafe URL', () => {
    const html = layout({ cta: { label: 'Reservar', url: 'https://studio.test/reservar' } });
    expect(html).toMatch(/class="em-cta"[\s\S]*mso-padding-alt:16px 32px[\s\S]*href="https:\/\/studio\.test\/reservar"[^>]*>Reservar<\/a>/);
    expect(layout()).not.toContain('class="em-cta"');
    expect(layout({ cta: { label: 'Reservar', url: 'javascript:alert(1)' } })).not.toContain('class="em-cta"');
  });

  it('escapes every caller string and never links an unsafe footer URL', () => {
    const html = layout({
      title: '<title>',
      headline: '<b>Hola</b>',
      brand: { name: '"><script>x</script>' },
      footer: {
        senderName: '<i>Sender</i>',
        links: [{ label: 'Web', url: 'javascript:alert(1)' }],
        address: 'Calle <1>',
        notice: 'Aviso & más',
        unsubscribe: { label: 'Cancelar', url: 'https://api.test/u?token=a"b' },
      },
    });
    expect(html).not.toMatch(/<script|<b>|<i>|javascript:/i);
    expect(html).toContain('&lt;b&gt;Hola&lt;/b&gt;');
    expect(html).toContain('Calle &lt;1&gt;');
    expect(html).toContain('Aviso &amp; más');
    expect(html).toContain('>Web<');
  });

  it('keeps the unsubscribe link with its query string intact', () => {
    expect(layout()).toContain('href="https://api.test/unsubscribe?token=a&amp;b=c" target="_blank"');
  });

  it('carries no script, tracking pixel, external stylesheet or SVG', () => {
    const html = layout({ brand: { name: 'North Strength', logo: LOGO } });
    expect(html).not.toMatch(/<script|<link[^>]+stylesheet|<svg|width="1"|height="1"/i);
  });
});

describe('plain text to email HTML', () => {
  it('splits paragraphs on blank lines and keeps single line breaks', () => {
    const html = plainTextToEmailHtml('Hola\r\n\r\nLínea 1\nLínea 2\n \n\n\nFin');
    expect(html.match(/<p /g)).toHaveLength(3);
    expect(html).toContain('Línea 1<br />Línea 2');
    // The last paragraph sits on the cell padding instead of adding its own margin.
    expect(html).toMatch(/<p style="margin:0;[^"]*">Fin<\/p>$/);
  });

  it('escapes markup instead of trusting it', () => {
    const html = plainTextToEmailHtml('<script>alert(1)</script> & <b>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b&gt;');
  });

  it('links only http(s) URLs and leaves sentence punctuation outside the link', () => {
    const html = plainTextToEmailHtml('Reserva en https://studio.test/clases?a=1&b=2. Más (ver https://studio.test/x_(y)) javascript:alert(1)');
    expect(html).toContain('href="https://studio.test/clases?a=1&amp;b=2"');
    expect(html).toContain('>https://studio.test/clases?a=1&amp;b=2</a>.');
    expect(html).toContain('href="https://studio.test/x_(y)"');
    expect(html).toContain('</a>)');
    expect(html).not.toContain('href="javascript');
  });

  it('does not link a scheme without a host or a URL glued to a word', () => {
    const html = plainTextToEmailHtml('Ver https:// y xhttps://studio.test');
    expect(html).not.toContain('<a ');
  });
});

describe('preheader', () => {
  it('flattens whitespace and cuts long text at a word boundary', () => {
    expect(emailPreheader('Hola\n\n  equipo')).toBe('Hola equipo');
    const long = emailPreheader('palabra '.repeat(40));
    expect(long.length).toBeLessThanOrEqual(111);
    expect(long.endsWith('palabra…')).toBe(true);
  });
});
