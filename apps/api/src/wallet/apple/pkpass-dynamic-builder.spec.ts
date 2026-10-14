import { SubscriptionSource, SubscriptionStatus } from '@prisma/client';
import { buildWalletPassDisplay } from '../access/wallet-access-display';
import { computeWalletAccessSnapshot, type WalletAccessInput } from '../access/wallet-access-snapshot';
import { buildPassJson } from './pkpass-builder';
import { buildDynamicPassJson, computePassContentHash, type DynamicPkpassInput } from './pkpass-dynamic-builder';

const TZ = 'America/Mexico_City';
const NOW = new Date('2026-10-13T18:00:00.000Z');

function snapshotInput(overrides: Partial<WalletAccessInput> = {}): WalletAccessInput {
  return {
    studio: { id: 'studio_1', timezone: TZ },
    member: { userId: 'user_1', firstName: 'Ana', lastName: 'Prueba' },
    credential: { id: 'wc_1', revokedAt: null },
    studioMembershipActive: true,
    subscriptions: [
      {
        id: 'sub_1',
        status: SubscriptionStatus.ACTIVE,
        source: SubscriptionSource.CASH,
        currentPeriodStart: new Date('2026-10-01T06:00:00.000Z'),
        currentPeriodEnd: new Date('2026-11-01T06:00:00.000Z'),
        entitlementEndsAt: null,
        cancelAtPeriodEnd: true,
        exclusiveGroupKey: 'CORE',
        supersededBySubscriptionId: null,
        endReason: null,
        createdAt: new Date('2026-10-01T06:00:00.000Z'),
        plan: {
          id: 'plan_full',
          name: 'Full Access',
          classCredits: null,
          allClassesAccess: true,
          entitlementDays: null,
          openGymAccess: true,
          openGymWindowStart: '05:00',
          openGymWindowEnd: '22:00',
        },
      },
    ],
    dayPasses: [],
    ...overrides,
  };
}

function dynamicInput(snapshot = computeWalletAccessSnapshot(snapshotInput(), NOW)): DynamicPkpassInput {
  return {
    passTypeIdentifier: 'pass.co.gymos.member.test',
    teamIdentifier: 'TEAM123',
    serialNumber: 'wc_1',
    organizationName: 'ARES Training Club',
    memberName: 'Ana Prueba',
    barcodeMessage: 'gymos:v1:raw-value',
    backgroundColorRgb: 'rgb(10,10,10)',
    foregroundColorRgb: 'rgb(255,255,255)',
    labelColorRgb: 'rgb(160,160,160)',
    supportEmail: 'hola@ares.mx',
    termsUrl: 'https://ares.mx/terminos',
    hasLogoImage: true,
    webServiceURL: 'https://api.example.test/api/v1/wallet/passkit',
    authenticationToken: 'tok_'.padEnd(43, 'x'),
    display: buildWalletPassDisplay(snapshot),
  };
}

describe('buildDynamicPassJson', () => {
  it('keeps the static pass identity: same serial, same barcode, same pass type and colors', () => {
    const input = dynamicInput();
    const dynamic = buildDynamicPassJson(input);
    const staticPass = buildPassJson({ ...input, planName: 'Full Access' });

    expect(dynamic.serialNumber).toBe(staticPass.serialNumber);
    expect(dynamic.barcodes).toEqual(staticPass.barcodes);
    expect(dynamic.passTypeIdentifier).toBe(staticPass.passTypeIdentifier);
    expect(dynamic.teamIdentifier).toBe(staticPass.teamIdentifier);
    expect(dynamic.description).toBe(staticPass.description);
    expect([dynamic.backgroundColor, dynamic.foregroundColor, dynamic.labelColor]).toEqual([
      staticPass.backgroundColor,
      staticPass.foregroundColor,
      staticPass.labelColor,
    ]);
    expect(dynamic.generic.primaryFields).toEqual(staticPass.generic.primaryFields);
  });

  it('adds the PassKit web service and the per-pass token', () => {
    const dynamic = buildDynamicPassJson(dynamicInput());
    expect(dynamic.webServiceURL).toBe('https://api.example.test/api/v1/wallet/passkit');
    expect(dynamic.authenticationToken).toHaveLength(43);
  });

  it('puts the membership STATE in the header and plan/validity/scope in the body', () => {
    const dynamic = buildDynamicPassJson(dynamicInput());
    expect(dynamic.generic.headerFields).toEqual([{ key: 'status', label: 'ESTADO', value: 'VIGENTE' }]);
    expect(dynamic.generic.secondaryFields).toEqual([
      { key: 'plan', label: 'PLAN', value: 'Full Access' },
      { key: 'validity', label: 'VIGENCIA', value: 'Vigente hasta el 31 oct 2026' },
    ]);
    expect(dynamic.generic.auxiliaryFields).toEqual([{ key: 'scope', label: 'INCLUYE', value: 'Todas las clases · Gimnasio 05:00–22:00' }]);
    // Generic pass + square barcode: secondary + auxiliary must not exceed 4.
    expect(dynamic.generic.secondaryFields.length + dynamic.generic.auxiliaryFields.length).toBeLessThanOrEqual(4);
    expect(dynamic.generic.backFields.map((f) => f.key)).toEqual(['membership_1', 'about', 'disclaimer', 'support', 'terms']);
  });

  it('an expired membership is NOT voided and claims no access; nothing makes Wallet hide the pass', () => {
    const expired = computeWalletAccessSnapshot(snapshotInput(), new Date('2026-11-05T18:00:00.000Z'));
    const dynamic = buildDynamicPassJson(dynamicInput(expired));
    expect(dynamic.generic.headerFields[0]!.value).toBe('VENCIDA');
    expect(dynamic).not.toHaveProperty('voided');
    for (const key of ['expirationDate', 'relevantDate', 'locations', 'beacons', 'sharingProhibited']) {
      expect(dynamic).not.toHaveProperty(key);
    }
    expect(JSON.stringify(dynamic)).not.toMatch(/changeMessage/);
    expect(JSON.stringify(dynamic.generic.headerFields)).not.toMatch(/ACCESO/);
  });

  it('only a revoked credential\'s pass is voided — and it keeps its serial and barcode', () => {
    const revoked = computeWalletAccessSnapshot(snapshotInput({ credential: { id: 'wc_1', revokedAt: new Date('2026-10-12T00:00:00Z') } }), NOW);
    const dynamic = buildDynamicPassJson(dynamicInput(revoked));
    expect(dynamic.voided).toBe(true);
    expect(dynamic.serialNumber).toBe('wc_1');
    expect(dynamic.barcodes[0]!.message).toBe('gymos:v1:raw-value');
  });

  it('uses logoText only when there is no logo image (same rule as the static pass)', () => {
    expect(buildDynamicPassJson({ ...dynamicInput(), hasLogoImage: false }).logoText).toBe('ARES Training Club');
    expect(buildDynamicPassJson(dynamicInput())).not.toHaveProperty('logoText');
  });
});

describe('computePassContentHash', () => {
  const images = { 'icon.png': Buffer.from([1, 2, 3]), 'logo.png': Buffer.from([4, 5, 6]) };

  it('is deterministic for identical content and independent of image insertion order', () => {
    const passJson = Buffer.from(JSON.stringify(buildDynamicPassJson(dynamicInput())));
    const reordered = { 'logo.png': images['logo.png'], 'icon.png': images['icon.png'] };
    expect(computePassContentHash(passJson, images)).toBe(computePassContentHash(Buffer.from(passJson), reordered));
  });

  it('changes when what the member sees changes, or when an asset changes', () => {
    const active = Buffer.from(JSON.stringify(buildDynamicPassJson(dynamicInput())));
    const expired = Buffer.from(
      JSON.stringify(buildDynamicPassJson(dynamicInput(computeWalletAccessSnapshot(snapshotInput(), new Date('2026-11-05T18:00:00.000Z'))))),
    );
    expect(computePassContentHash(active, images)).not.toBe(computePassContentHash(expired, images));
    expect(computePassContentHash(active, images)).not.toBe(
      computePassContentHash(active, { ...images, 'icon.png': Buffer.from([9]) }),
    );
  });

  it('does not change merely because time passed inside the same state', () => {
    const at = (iso: string) =>
      Buffer.from(JSON.stringify(buildDynamicPassJson(dynamicInput(computeWalletAccessSnapshot(snapshotInput(), new Date(iso))))));
    expect(computePassContentHash(at('2026-10-13T18:00:00.000Z'), images)).toBe(
      computePassContentHash(at('2026-10-20T09:30:00.000Z'), images),
    );
  });
});
