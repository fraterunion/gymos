import {
  buildClassId,
  buildGenericClass,
  buildGenericObject,
  buildObjectId,
  buildSaveJwtPayload,
} from './google-object-builder';
import type { WalletPassBranding } from '../wallet-pass-branding.resolver';

const branding: WalletPassBranding = {
  organizationName: 'ARES Training Club',
  studioSlug: 'ares-fitness',
  logoUrl: null,
  supportEmail: 'hola@ares.mx',
  supportPhone: null,
  privacyUrl: null,
  termsUrl: 'https://ares.mx/terminos',
  backgroundColorRgb: 'rgb(10,10,10)',
  backgroundColorHex: '#0a0a0a',
  foregroundColorRgb: 'rgb(255,255,255)',
  labelColorRgb: 'rgb(160,160,160)',
};

describe('buildClassId / buildObjectId', () => {
  it('deterministically derives IDs from issuerId + studioId/walletCredentialId', () => {
    expect(buildClassId('3388000000012345', 'studio-1')).toBe('3388000000012345.studio_studio-1');
    expect(buildObjectId('3388000000012345', 'wc1')).toBe('3388000000012345.credential_wc1');
  });

  it('is stable across calls (same inputs -> same id, needed for idempotent get-or-create)', () => {
    expect(buildObjectId('issuer', 'wc1')).toBe(buildObjectId('issuer', 'wc1'));
  });
});

describe('buildGenericClass', () => {
  it('is one class per studio, carrying only the issuer-facing name', () => {
    const cls = buildGenericClass({ classId: 'issuer.studio_1', issuerName: 'ARES Training Club' });
    expect(cls['id']).toBe('issuer.studio_1');
    expect(cls['issuerName']).toBe('ARES Training Club');
  });
});

describe('buildGenericObject', () => {
  it('carries the exact "gymos:v1:" barcode and correct class association', () => {
    const obj = buildGenericObject({
      objectId: 'issuer.credential_wc1',
      classId: 'issuer.studio_1',
      memberName: 'Ivonne Araujo',
      planName: 'Full Access',
      barcodeMessage: 'gymos:v1:rawvalue',
      branding,
    });
    expect(obj['classId']).toBe('issuer.studio_1');
    expect(obj['barcode']).toEqual({ type: 'QR_CODE', value: 'gymos:v1:rawvalue' });
  });

  it('never embeds userId/studioId — only the opaque barcode message', () => {
    const obj = buildGenericObject({
      objectId: 'issuer.credential_wc1',
      classId: 'issuer.studio_1',
      memberName: 'Ivonne Araujo',
      planName: null,
      barcodeMessage: 'gymos:v1:rawvalue',
      branding,
    });
    const raw = JSON.stringify(obj);
    expect(raw).not.toMatch(/user.?id|studio.?id/i);
  });

  it('shows the member name and plan name via header/subheader', () => {
    const obj = buildGenericObject({
      objectId: 'x',
      classId: 'y',
      memberName: 'Ivonne Araujo',
      planName: 'Full Access',
      barcodeMessage: 'gymos:v1:raw',
      branding,
    }) as { header: { defaultValue: { value: string } }; subheader?: { defaultValue: { value: string } } };
    expect(obj.header.defaultValue.value).toBe('Ivonne Araujo');
    expect(obj.subheader?.defaultValue.value).toBe('Full Access');
  });

  it('omits subheader entirely when the member has no plan', () => {
    const obj = buildGenericObject({
      objectId: 'x',
      classId: 'y',
      memberName: 'Ivonne Araujo',
      planName: null,
      barcodeMessage: 'gymos:v1:raw',
      branding,
    });
    expect(obj['subheader']).toBeUndefined();
  });

  it('applies studio branding (org name, hex background color)', () => {
    const obj = buildGenericObject({
      objectId: 'x',
      classId: 'y',
      memberName: 'Test',
      planName: null,
      barcodeMessage: 'gymos:v1:raw',
      branding,
    }) as { cardTitle: { defaultValue: { value: string } }; hexBackgroundColor: string };
    expect(obj.cardTitle.defaultValue.value).toBe('ARES Training Club');
    expect(obj.hexBackgroundColor).toBe('#0a0a0a');
  });

  it('always includes the access-confirmed-at-front-desk disclaimer text module', () => {
    const obj = buildGenericObject({
      objectId: 'x',
      classId: 'y',
      memberName: 'Test',
      planName: null,
      barcodeMessage: 'gymos:v1:raw',
      branding,
    }) as { textModulesData: Array<{ id: string; body: string }> };
    const disclaimer = obj.textModulesData.find((m) => m.id === 'disclaimer');
    expect(disclaimer?.body).toBe('El acceso se confirma en recepción.');
  });
});

describe('buildSaveJwtPayload', () => {
  it('references the object by ID only — no barcode/credential re-embedded in the save JWT', () => {
    const payload = buildSaveJwtPayload('svc@project.iam.gserviceaccount.com', 'issuer.credential_wc1');
    expect(payload).toEqual({
      iss: 'svc@project.iam.gserviceaccount.com',
      aud: 'google',
      typ: 'savetowallet',
      iat: expect.any(Number),
      payload: { genericObjects: [{ id: 'issuer.credential_wc1' }] },
    });
    expect(JSON.stringify(payload)).not.toContain('gymos:v1:');
  });
});
