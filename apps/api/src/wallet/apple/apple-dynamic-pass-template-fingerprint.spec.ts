import { createHash } from 'node:crypto';
import type { WalletPassDisplay } from '../access/wallet-access-display';
import { APPLE_DYNAMIC_PASS_TEMPLATE_VERSION } from './apple-wallet.constants';
import { buildDynamicPassJson } from './pkpass-dynamic-builder';

/**
 * The dynamic counterpart of apple-pass-template-fingerprint.spec.ts. Changing the dynamic
 * pass structure without bumping APPLE_DYNAMIC_PASS_TEMPLATE_VERSION fails here. Member data and
 * display values are sentinels, so the fingerprint depends on structure only.
 */
const SENTINEL_DISPLAY: WalletPassDisplay = {
  status: { key: 'status', label: 'SENTINEL_STATUS_LABEL', value: 'SENTINEL_STATUS' },
  plan: { key: 'plan', label: 'SENTINEL_PLAN_LABEL', value: 'SENTINEL_PLAN' },
  validity: { key: 'validity', label: 'SENTINEL_VALIDITY_LABEL', value: 'SENTINEL_VALIDITY' },
  scope: { key: 'scope', label: 'SENTINEL_SCOPE_LABEL', value: 'SENTINEL_SCOPE' },
  details: [{ key: 'membership_1', label: 'SENTINEL_DETAIL_LABEL', value: 'SENTINEL_DETAIL' }],
  voided: false,
};

function dynamicTemplateFingerprint(): string {
  const pass = buildDynamicPassJson({
    passTypeIdentifier: 'SENTINEL_PASS_TYPE',
    teamIdentifier: 'SENTINEL_TEAM',
    serialNumber: 'SENTINEL_SERIAL',
    organizationName: 'SENTINEL_ORG',
    memberName: 'SENTINEL_MEMBER',
    barcodeMessage: 'SENTINEL_BARCODE',
    backgroundColorRgb: 'rgb(10,10,10)',
    foregroundColorRgb: 'rgb(255,255,255)',
    labelColorRgb: 'rgb(160,160,160)',
    supportEmail: 'SENTINEL_EMAIL',
    termsUrl: 'SENTINEL_TERMS',
    hasLogoImage: true,
    webServiceURL: 'SENTINEL_WEB_SERVICE_URL',
    authenticationToken: 'SENTINEL_TOKEN',
    display: SENTINEL_DISPLAY,
  });
  return createHash('sha256').update(JSON.stringify(pass)).digest('hex');
}

describe('Apple DYNAMIC pass template versioning', () => {
  // If this fails, you changed the dynamic pass structure. Bump
  // APPLE_DYNAMIC_PASS_TEMPLATE_VERSION and update this constant in the same commit.
  const PINNED_FINGERPRINT = '57151c04b948e44df42f1afeb7ed23953f00042a4105b40acff795377162679f';
  const PINNED_VERSION = 1;

  it('has a template fingerprint matching the declared version', () => {
    expect(APPLE_DYNAMIC_PASS_TEMPLATE_VERSION).toBe(PINNED_VERSION);
    expect(dynamicTemplateFingerprint()).toBe(PINNED_FINGERPRINT);
  });
});
