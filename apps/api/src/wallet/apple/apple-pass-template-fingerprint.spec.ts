import { createHash } from 'node:crypto';
import { APPLE_PASS_TEMPLATE_VERSION } from './apple-wallet.constants';
import { buildPassJson } from './pkpass-builder';
import { APPLE_BRAND_IMAGE_FILES, loadAppleBrandImages } from './wallet-brand-assets';

/**
 * Guards the one failure mode the versioning scheme cannot detect by itself: changing the
 * pass design and forgetting to bump APPLE_PASS_TEMPLATE_VERSION, which would leave every
 * existing member pinned to the old artifact forever — exactly the bug this scheme exists to
 * prevent.
 *
 * The fingerprint covers the rendered template shape (member data replaced by sentinels, so
 * it depends on structure/labels/colours, not on who the member is) plus the bytes of every
 * bundled brand asset.
 */
function templateFingerprint(): string {
  const pass = buildPassJson({
    passTypeIdentifier: 'SENTINEL_PASS_TYPE',
    teamIdentifier: 'SENTINEL_TEAM',
    serialNumber: 'SENTINEL_SERIAL',
    organizationName: 'SENTINEL_ORG',
    memberName: 'SENTINEL_MEMBER',
    planName: 'SENTINEL_PLAN',
    barcodeMessage: 'SENTINEL_BARCODE',
    backgroundColorRgb: 'rgb(10,10,10)',
    foregroundColorRgb: 'rgb(255,255,255)',
    labelColorRgb: 'rgb(160,160,160)',
    supportEmail: 'SENTINEL_EMAIL',
    termsUrl: 'SENTINEL_TERMS',
    hasLogoImage: true,
  });

  const hash = createHash('sha256').update(JSON.stringify(pass));
  const images = loadAppleBrandImages('ares-fitness');
  for (const file of APPLE_BRAND_IMAGE_FILES) {
    hash.update(file).update(images![file]);
  }
  return hash.digest('hex');
}

describe('Apple pass template versioning', () => {
  // If this fails, you changed the pass design or its assets. Bump
  // APPLE_PASS_TEMPLATE_VERSION and update this constant in the same commit, so existing
  // members' artifacts are regenerated instead of silently keeping the old look.
  const PINNED_FINGERPRINT = 'd1c6ec52fd11f3d748c0270216c0887ec123c1d4af73831452ce53a1a49c3057';
  const PINNED_VERSION = 2;

  it('has a template fingerprint matching the declared version', () => {
    expect(APPLE_PASS_TEMPLATE_VERSION).toBe(PINNED_VERSION);
    expect(templateFingerprint()).toBe(PINNED_FINGERPRINT);
  });

  it('produces a stable fingerprint across calls', () => {
    expect(templateFingerprint()).toBe(templateFingerprint());
  });
});
