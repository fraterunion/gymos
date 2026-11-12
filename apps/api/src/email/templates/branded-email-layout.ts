import { safeHexColor } from '../email-branding';
import { escapeHtml } from './password-reset.template';

/**
 * Branded layout for studio email. White-label: every name, logo, colour and link comes from the
 * caller, so nothing in this file may mention a particular studio.
 *
 * Email-client constraints that shaped the markup:
 *  · Tables and inline styles carry the whole design. The <style> blocks only add the phone
 *    breakpoint and client resets, so a client that strips them (Gmail with non-Google accounts,
 *    Outlook) still renders the desktop layout intact.
 *  · Outlook for Windows ignores max-width and CSS image sizing: an MSO-only 600px table holds
 *    the column, and the logo is sized with width/height attributes.
 *  · The header is the graphite surface of the wallet pass and the app's pass card. Studio colour
 *    is only the 3px accent above it, as in the app, so a light brand colour can never produce
 *    white-on-white text. A logo shown there must therefore read on a dark background.
 *  · Remote images are off by default in many inboxes: the logo carries the studio name as styled
 *    ALT text, and a studio without a logo gets its name as real text. Never both.
 */

export type EmailImage = { url: string; width: number; height: number };

export type EmailLink = { label: string; url: string };

export type BrandedEmailLayoutInput = {
  locale?: 'es' | 'en';
  /** Document title. */
  title: string;
  /** Inbox preview line, hidden in the message itself. */
  preheader?: string | null;
  brand: {
    name: string;
    /** Must be HTTPS and legible on the dark header; anything else falls back to the name. */
    logo?: EmailImage | null;
    accentColor?: string | null;
  };
  headline?: string | null;
  /** Trusted markup: build it with plainTextToEmailHtml, or escape every interpolated value. */
  bodyHtml: string;
  cta?: EmailLink | null;
  footer: {
    senderName: string;
    links?: EmailLink[];
    address?: string | null;
    notice: string;
    unsubscribe?: EmailLink | null;
  };
};

const PAGE = '#F0F0F0';
const CARD = '#FFFFFF';
const SURFACE = '#0A0A0A';
const SURFACE_EDGE = '#1A1A1A';
const ON_SURFACE = '#FFFFFF';
const INK = '#0A0A0A';
const BODY = '#3A3A3A';
const MUTED = '#6B6B6B';
const FAINT = '#B4B4B4';
const HAIRLINE = '#E8E8E8';
const FOOTER = '#F7F7F7';
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

const LOGO_MAX_WIDTH = 220;
const LOGO_MAX_HEIGHT = 52;

const PARAGRAPH = `font-family:${FONT};font-size:16px;line-height:26px;color:${BODY}`;
const BODY_LINK = `color:${INK};font-weight:600;text-decoration:underline;word-break:break-word;overflow-wrap:anywhere`;

/** Keeps the body copy out of the inbox preview after a short preheader. */
const PREHEADER_FILL = '&#847;&zwnj;&nbsp;'.repeat(90);

const SAFE_HREF = /^(?:https?:\/\/[^\s"'<>]+|mailto:[^\s"'<>]+|#[\w-]*)$/i;
const HTTPS_IMAGE = /^https:\/\/[^\s"'<>]+$/i;

/**
 * Accent stripe on the graphite header. Near-black studio colours (e.g. slate-950) are
 * invisible there, so they are dropped rather than drawing a phantom line.
 */
export function accentOnDarkSurface(hex: string | null | undefined): string | null {
  const accent = safeHexColor(hex);
  if (!accent) return null;
  const rgb = parseHexRgb(accent);
  if (!rgb) return null;
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const accentL = 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
  // SURFACE (#0A0A0A) ≈ 0.003. A thin 3px stripe needs ~2:1 contrast to read at all.
  const surfaceL = 0.003;
  const lighter = Math.max(accentL, surfaceL);
  const darker = Math.min(accentL, surfaceL);
  const contrast = (lighter + 0.05) / (darker + 0.05);
  return contrast >= 2 ? accent : null;
}

function parseHexRgb(hex: string): { r: number; g: number; b: number } | null {
  const raw = hex.slice(1);
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  if (full.length !== 6) return null;
  const n = Number.parseInt(full, 16);
  if (!Number.isFinite(n)) return null;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function safeHref(url: string): string | null {
  const trimmed = url.trim();
  return SAFE_HREF.test(trimmed) ? trimmed : null;
}

function anchor(link: EmailLink, style: string): string {
  const href = safeHref(link.url);
  const label = escapeHtml(link.label);
  return href ? `<a href="${escapeHtml(href)}" target="_blank" style="${style}">${label}</a>` : label;
}

function lockup(brand: BrandedEmailLayoutInput['brand']): string {
  const type = `font-family:${FONT};font-size:15px;line-height:20px;font-weight:700;letter-spacing:4px;text-transform:uppercase;color:${ON_SURFACE}`;
  const name = escapeHtml(brand.name);
  const logo = brand.logo;
  if (
    !logo ||
    !HTTPS_IMAGE.test(logo.url) ||
    !(logo.width > 0 && logo.height > 0 && Number.isFinite(logo.width) && Number.isFinite(logo.height))
  ) {
    return `<p style="margin:0;${type}">${name}</p>`;
  }
  const scale = Math.min(1, LOGO_MAX_WIDTH / logo.width, LOGO_MAX_HEIGHT / logo.height);
  const width = Math.max(1, Math.round(logo.width * scale));
  const height = Math.max(1, Math.round(logo.height * scale));
  return `<img src="${escapeHtml(logo.url)}" width="${width}" height="${height}" alt="${name}" style="display:block;margin:0 auto;width:${width}px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;${type}" />`;
}

function ctaButton(cta: EmailLink): string {
  const href = safeHref(cta.url);
  if (!href) return '';
  return `<table role="presentation" class="em-cta" cellpadding="0" cellspacing="0" border="0" style="margin:32px 0 0">
<tr><td align="center" bgcolor="${SURFACE}" style="background:${SURFACE};border-radius:12px;mso-padding-alt:16px 32px">
<a href="${escapeHtml(href)}" target="_blank" style="display:inline-block;padding:16px 32px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:700;letter-spacing:0.2px;color:${ON_SURFACE};text-decoration:none;border-radius:12px">${escapeHtml(cta.label)}</a>
</td></tr>
</table>`;
}

function footerBlock(footer: BrandedEmailLayoutInput['footer']): string {
  const link = `color:${MUTED};text-decoration:underline`;
  const separator = `<span style="color:${FAINT}"> &middot; </span>`;
  const links = (footer.links ?? []).map((item) => anchor(item, link)).join(separator);
  const unsubscribe = footer.unsubscribe
    ? `<br />${anchor(footer.unsubscribe, `color:${BODY};text-decoration:underline`)}`
    : '';
  return [
    `<p style="margin:0;font-family:${FONT};font-size:11px;line-height:16px;font-weight:700;letter-spacing:2.4px;text-transform:uppercase;color:${INK}">${escapeHtml(footer.senderName)}</p>`,
    links
      ? `<p style="margin:12px 0 0;font-family:${FONT};font-size:13px;line-height:20px;color:${MUTED}">${links}</p>`
      : '',
    footer.address
      ? `<p style="margin:8px 0 0;font-family:${FONT};font-size:12px;line-height:18px;color:${MUTED}">${escapeHtml(footer.address)}</p>`
      : '',
    `<p style="margin:20px 0 0;font-family:${FONT};font-size:12px;line-height:18px;color:${MUTED}">${escapeHtml(footer.notice)}${unsubscribe}</p>`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function renderBrandedEmailLayout(input: BrandedEmailLayoutInput): string {
  const locale = input.locale ?? 'es';
  const accent = accentOnDarkSurface(input.brand.accentColor);
  const preheader = input.preheader?.trim()
    ? `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">${escapeHtml(input.preheader.trim())}${PREHEADER_FILL}</div>`
    : '';
  const headlineText = input.headline?.trim() ?? '';
  const headline = headlineText
    ? `<h1 class="em-headline" style="margin:0;font-family:${FONT};font-size:30px;line-height:36px;font-weight:800;letter-spacing:-0.6px;color:${INK}">${escapeHtml(headlineText)}</h1>
<table role="presentation" class="em-rule" width="48" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 26px"><tr><td height="2" style="height:2px;line-height:2px;font-size:0;background:${INK}">&nbsp;</td></tr></table>`
    : '';

  return `<!doctype html>
<html lang="${locale}" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${escapeHtml(input.title)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<!--[if mso]><style>table,td,h1,p,a,span{font-family:'Segoe UI',Arial,sans-serif !important}</style><![endif]-->
<style>
body{margin:0 !important;padding:0 !important;width:100% !important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
table,td{mso-table-lspace:0pt;mso-table-rspace:0pt}
img{-ms-interpolation-mode:bicubic}
@media only screen and (max-width:620px){
.em-page{padding:0 !important}
.em-card{border-radius:0 !important}
.em-header{border-radius:0 !important;padding:36px 24px 34px !important}
.em-body{padding:36px 24px 32px !important}
.em-footer{border-radius:0 !important;padding:28px 24px 32px !important}
.em-headline{font-size:26px !important;line-height:32px !important}
.em-cta{width:100% !important}
.em-cta a{display:block !important}
}
</style>
<style>
:root{color-scheme:light;supported-color-schemes:light}
a[x-apple-data-detectors]{color:inherit !important;text-decoration:none !important;font-size:inherit !important;font-family:inherit !important;font-weight:inherit !important;line-height:inherit !important}
</style>
</head>
<body style="margin:0;padding:0;background:${PAGE}">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE}" style="background:${PAGE}">
<tr>
<td align="center" class="em-page" style="padding:40px 12px 48px">
<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" class="em-card" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:${CARD};border-radius:16px;overflow:hidden">
<tr>
<td class="em-header" align="center" bgcolor="${SURFACE}" style="background:${SURFACE};${accent ? `border-top:3px solid ${accent};` : ''}border-bottom:1px solid ${SURFACE_EDGE};border-radius:16px 16px 0 0;padding:44px 40px 40px">
${lockup(input.brand)}
</td>
</tr>
<tr>
<td class="em-body" style="padding:48px 48px 44px;font-family:${FONT}">
${headline}
${input.bodyHtml}
${input.cta ? ctaButton(input.cta) : ''}
</td>
</tr>
<tr>
<td class="em-footer" align="center" bgcolor="${FOOTER}" style="background:${FOOTER};border-top:1px solid ${HAIRLINE};border-radius:0 0 16px 16px;padding:32px 48px 36px">
${footerBlock(input.footer)}
</td>
</tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td>
</tr>
</table>
</body>
</html>`;
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"]+/gi;

/** Sentence punctuation after a URL is not part of it, except a ")" closing a "(" inside it. */
function trimTrailingPunctuation(url: string): string {
  let out = url;
  while (/[.,;:!?'»…)\]]$/.test(out)) {
    if (out.endsWith(')') && (out.match(/\(/g)?.length ?? 0) >= (out.match(/\)/g)?.length ?? 0)) break;
    out = out.slice(0, -1);
  }
  return out;
}

function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function linkify(line: string): string {
  let html = '';
  let cursor = 0;
  for (const match of line.matchAll(URL_IN_TEXT)) {
    const start = match.index ?? 0;
    const url = trimTrailingPunctuation(match[0]);
    if (!isWebUrl(url)) continue;
    html += escapeHtml(line.slice(cursor, start));
    html += `<a href="${escapeHtml(url)}" target="_blank" style="${BODY_LINK}">${escapeHtml(url)}</a>`;
    cursor = start + url.length;
  }
  return html + escapeHtml(line.slice(cursor));
}

/**
 * Admin-authored plain text as email paragraphs: blank lines split paragraphs, single newlines
 * are kept, and only http(s) URLs become links. Everything else is escaped text.
 */
export function plainTextToEmailHtml(text: string): string {
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((block) => block.replace(/^\n+|\n+$/g, ''))
    .filter((block) => block.trim().length > 0);
  return paragraphs
    .map((block, index) => {
      const margin = index === paragraphs.length - 1 ? '0' : '0 0 18px';
      return `<p style="margin:${margin};${PARAGRAPH}">${block.split('\n').map(linkify).join('<br />')}</p>`;
    })
    .join('\n');
}

/** Inbox preview text from the message itself, cut at a word boundary. */
export function emailPreheader(text: string, max = 110): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
