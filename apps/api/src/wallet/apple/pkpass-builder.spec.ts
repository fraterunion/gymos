import { buildPassJson, parseRgbFunction } from './pkpass-builder';

describe('buildPassJson', () => {
  const base = {
    passTypeIdentifier: 'pass.co.gymos.member',
    teamIdentifier: 'TEAM123',
    serialNumber: 'wc_abc123',
    organizationName: 'ARES Training Club',
    memberName: 'Ivonne Araujo',
    planName: 'Full Access',
    barcodeMessage: 'gymos:v1:rawvalue',
    backgroundColorRgb: 'rgb(10,10,10)',
    foregroundColorRgb: 'rgb(255,255,255)',
    labelColorRgb: 'rgb(160,160,160)',
    supportEmail: 'hola@ares.mx',
    termsUrl: 'https://ares.mx/terminos',
    hasLogoImage: true,
  };

  it('never embeds userId/studioId — only the opaque barcode message', () => {
    const pass = buildPassJson(base);
    const raw = JSON.stringify(pass);
    expect(raw).toContain('gymos:v1:rawvalue');
    expect(raw).not.toMatch(/user.?id|studio.?id/i);
  });

  it('wires the correct passTypeIdentifier and teamIdentifier', () => {
    const pass = buildPassJson(base);
    expect(pass.passTypeIdentifier).toBe('pass.co.gymos.member');
    expect(pass.teamIdentifier).toBe('TEAM123');
  });

  it('uses the WalletCredential id as the serial number', () => {
    const pass = buildPassJson(base);
    expect(pass.serialNumber).toBe('wc_abc123');
  });

  it('has exactly one QR barcode carrying the full "gymos:v1:" message', () => {
    const pass = buildPassJson(base);
    expect(pass.barcodes).toEqual([
      { format: 'PKBarcodeFormatQR', message: 'gymos:v1:rawvalue', messageEncoding: 'iso-8859-1' },
    ]);
  });

  it('applies member/studio branding colors', () => {
    const pass = buildPassJson(base);
    expect(pass.backgroundColor).toBe('rgb(10,10,10)');
    expect(pass.foregroundColor).toBe('rgb(255,255,255)');
    expect(pass.labelColor).toBe('rgb(160,160,160)');
  });

  it('shows the member name as the primary field', () => {
    const pass = buildPassJson(base);
    expect(pass.generic.primaryFields).toEqual([{ key: 'name', label: 'MIEMBRO', value: 'Ivonne Araujo' }]);
  });

  // The collapsed Wallet stack only exposes the logo and the header fields, so the plan lives
  // in the header — a member must be able to read club + tier without opening the pass.
  it('puts the plan in headerFields so it survives the collapsed Wallet stack', () => {
    const pass = buildPassJson(base);
    expect(pass.generic.headerFields).toEqual([{ key: 'plan', label: 'PLAN', value: 'Full Access' }]);
    expect(pass.generic.secondaryFields).toEqual([]);
  });

  it('omits the plan field entirely when the member has no plan', () => {
    const pass = buildPassJson({ ...base, planName: null });
    expect(pass.generic.headerFields).toEqual([]);
    // Identity is never destroyed by a missing plan — the member name still renders.
    expect(pass.generic.primaryFields).toEqual([{ key: 'name', label: 'MIEMBRO', value: 'Ivonne Araujo' }]);
  });

  it('omits logoText when real logo artwork ships, so Wallet never renders both', () => {
    expect(buildPassJson(base).logoText).toBeUndefined();
  });

  it('falls back to logoText for a studio with no checked-in Wallet artwork', () => {
    const pass = buildPassJson({ ...base, hasLogoImage: false });
    expect(pass.logoText).toBe('ARES Training Club');
  });

  it('always includes the "access confirmed at front desk" disclaimer', () => {
    const pass = buildPassJson(base);
    const disclaimer = pass.generic.backFields.find((f) => f.key === 'disclaimer');
    expect(disclaimer?.value).toBe('El acceso se confirma en recepción.');
  });

  it('explains what the pass is on the back, naming the studio from canonical data', () => {
    const pass = buildPassJson(base);
    const about = pass.generic.backFields.find((f) => f.key === 'about');
    expect(about?.value).toBe('Este pase identifica tu membresía en ARES Training Club.');
  });

  it('never exposes a phone number or any contact detail that was not supplied', () => {
    const pass = buildPassJson({ ...base, supportEmail: null, termsUrl: null });
    const keys = pass.generic.backFields.map((f) => f.key);
    expect(keys).toEqual(['about', 'disclaimer']);
  });

  it('never sets webServiceURL/authenticationToken (static pass, no APNs this phase)', () => {
    const pass = buildPassJson(base) as Record<string, unknown>;
    expect(pass['webServiceURL']).toBeUndefined();
    expect(pass['authenticationToken']).toBeUndefined();
  });

  it('never sets locations/beacons/relevantDate (no relevance features this phase)', () => {
    const pass = buildPassJson(base) as Record<string, unknown>;
    expect(pass['locations']).toBeUndefined();
    expect(pass['beacons']).toBeUndefined();
    expect(pass['relevantDate']).toBeUndefined();
  });
});

describe('parseRgbFunction', () => {
  it('parses a valid rgb() function', () => {
    expect(parseRgbFunction('rgb(10,20,30)')).toEqual([10, 20, 30]);
  });

  it('throws on anything else', () => {
    expect(() => parseRgbFunction('#0a0a0a')).toThrow();
  });
});
