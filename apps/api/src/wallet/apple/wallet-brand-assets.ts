import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Apple's required/optional image set for a `generic` pass. `icon` is mandatory (notifications,
 * lock screen, share sheet); `logo` is what Wallet draws in the pass's top-left corner — the
 * ONLY brand element that stays visible while the pass is collapsed underneath another card in
 * the Wallet stack, which is why a pass without one reads as an empty coloured rectangle.
 * `strip`/`background`/`footer` are not part of the `generic` style and are deliberately absent.
 */
export const APPLE_BRAND_IMAGE_FILES = [
  'icon.png',
  'icon@2x.png',
  'icon@3x.png',
  'logo.png',
  'logo@2x.png',
  'logo@3x.png',
] as const;

export type AppleBrandImages = Record<(typeof APPLE_BRAND_IMAGE_FILES)[number], Buffer>;

/**
 * Assets are checked in per studio slug, mirroring how the mobile app already ships per-tenant
 * brand assets under `assets/branding/<profile>/`. `ares-fitness/` is derived deterministically
 * from that same canonical source — the wordmark from `splash-wordmark.png` (1800x461,
 * white-on-transparent) downscaled to Apple's 160x50pt logo budget at 160x41, and the icon from
 * `icon.png` (1024x1024 A-mark) downscaled to 29pt. Both are downscales of the production
 * artwork, never upscales, and no new brand asset was invented.
 */
const ASSET_ROOT = join(__dirname, 'assets');

/** Slugs come from the database; this keeps a hostile value from escaping the asset root. */
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

const cache = new Map<string, AppleBrandImages | null>();

/**
 * Returns the branded image set for a studio, or `null` when that studio has no checked-in
 * assets (the caller then falls back to generated placeholder icons plus a `logoText`, so every
 * tenant still gets a recognisable collapsed pass).
 *
 * Deliberately never throws. These files are copied into `dist/` by nest-cli at build time, and
 * a packaging regression must degrade the pass's appearance — not break issuance for a flow that
 * is already working in production.
 */
export function loadAppleBrandImages(studioSlug: string | null): AppleBrandImages | null {
  if (!studioSlug || !SAFE_SLUG.test(studioSlug)) {
    return null;
  }
  const cached = cache.get(studioSlug);
  if (cached !== undefined) {
    return cached;
  }

  let images: AppleBrandImages | null = null;
  try {
    const entries = APPLE_BRAND_IMAGE_FILES.map(
      (file) => [file, readFileSync(join(ASSET_ROOT, studioSlug, file))] as const,
    );
    images = Object.fromEntries(entries) as AppleBrandImages;
  } catch {
    images = null;
  }

  cache.set(studioSlug, images);
  return images;
}
