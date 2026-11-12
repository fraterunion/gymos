import type { EmailImage } from './templates/branded-email-layout';

/**
 * Logos drawn on the dark header of branded studio email, keyed by studio slug. The only place
 * per-studio email artwork is declared; everything else under src/email stays white-label.
 *
 * Studio `logoUrl` values are not used there: nothing guarantees they read on a dark surface,
 * are raster (Gmail and Outlook drop SVG), or have a known size (Outlook ignores CSS sizing and
 * needs width/height attributes). A studio without an entry gets its name set as type instead.
 */
const LOGOS = new Map<string, EmailImage>([
  [
    'ares-fitness',
    // apps/ares-site/public/ares-wordmark.png, white on transparent. Delivered campaigns keep
    // pointing at this URL, so renaming or removing that file blanks their header.
    { url: 'https://www.arestrainingclub.com/ares-wordmark.png', width: 800, height: 200 },
  ],
]);

export function studioEmailLogo(studioSlug: string | null | undefined): EmailImage | null {
  return (studioSlug && LOGOS.get(studioSlug)) || null;
}
