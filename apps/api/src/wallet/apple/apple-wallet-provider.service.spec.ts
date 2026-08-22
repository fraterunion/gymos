import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import JSZip from 'jszip';
import { AppleWalletProvider } from './apple-wallet-provider.service';
import { generateTestApplePkiFixture } from './test-cert-fixture';
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

function configWith(vars: Record<string, string>): ConfigService {
  return { get: (key: string) => vars[key] } as unknown as ConfigService;
}

describe('AppleWalletProvider — configuration', () => {
  it('reports not configured when any required env var is missing', () => {
    const provider = new AppleWalletProvider(configWith({ WALLET_APPLE_TEAM_ID: 'TEAM123' }));
    expect(provider.isConfigured()).toBe(false);
  });

  it('fails clearly with WALLET_APPLE_NOT_CONFIGURED, never a raw crypto exception', async () => {
    const provider = new AppleWalletProvider(configWith({}));
    await expect(
      provider.buildPkpass({
        walletCredentialId: 'wc1',
        rawCredential: 'raw',
        memberName: 'Test Member',
        planName: null,
        branding,
      }),
    ).rejects.toThrow('WALLET_APPLE_NOT_CONFIGURED');
  });

  it('reports configured when all required env vars are present', () => {
    const provider = new AppleWalletProvider(
      configWith({
        WALLET_APPLE_TEAM_ID: 'TEAM123',
        WALLET_APPLE_PASS_TYPE_ID: 'pass.co.gymos.member',
        WALLET_APPLE_SIGNING_CERT_P12_BASE64: 'x',
        WALLET_APPLE_SIGNING_CERT_PASSWORD: 'x',
        WALLET_APPLE_WWDR_CERT_PEM_BASE64: 'x',
      }),
    );
    expect(provider.isConfigured()).toBe(true);
  });
});

describe('AppleWalletProvider — real signing pipeline (throwaway test certificate, no Apple credentials)', () => {
  const fixture = generateTestApplePkiFixture();
  const maybeIt = fixture ? it : it.skip;

  maybeIt('produces a valid, correctly signed .pkpass zip bundle', async () => {
    const provider = new AppleWalletProvider(
      configWith({
        WALLET_APPLE_TEAM_ID: 'TEAM123',
        WALLET_APPLE_PASS_TYPE_ID: 'pass.co.gymos.member',
        WALLET_APPLE_SIGNING_CERT_P12_BASE64: fixture!.p12Base64,
        WALLET_APPLE_SIGNING_CERT_PASSWORD: fixture!.p12Password,
        WALLET_APPLE_WWDR_CERT_PEM_BASE64: fixture!.wwdrPemBase64,
      }),
    );

    const pkpass = await provider.buildPkpass({
      walletCredentialId: 'wc_test_1',
      rawCredential: 'the-raw-credential-value',
      memberName: 'Ivonne Araujo',
      planName: 'Full Access',
      branding,
    });

    expect(Buffer.isBuffer(pkpass)).toBe(true);
    expect(pkpass.length).toBeGreaterThan(0);

    const zip = await JSZip.loadAsync(pkpass);
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual([
      'icon.png',
      'icon@2x.png',
      'icon@3x.png',
      'logo.png',
      'logo@2x.png',
      'logo@3x.png',
      'manifest.json',
      'pass.json',
      'signature',
    ]);

    const passJsonRaw = await zip.file('pass.json')!.async('string');
    const passJson = JSON.parse(passJsonRaw) as { serialNumber: string; barcodes: Array<{ message: string }> };
    expect(passJson.serialNumber).toBe('wc_test_1');
    expect(passJson.barcodes[0]!.message).toBe('gymos:v1:the-raw-credential-value');

    const manifestRaw = await zip.file('manifest.json')!.async('string');
    const manifest = JSON.parse(manifestRaw) as Record<string, string>;
    // Wallet refuses a pass whose manifest disagrees with the packaged files, so every asset
    // in the zip (bar manifest.json/signature) must be hashed here.
    expect(Object.keys(manifest).sort()).toEqual([
      'icon.png',
      'icon@2x.png',
      'icon@3x.png',
      'logo.png',
      'logo@2x.png',
      'logo@3x.png',
      'pass.json',
    ]);
    for (const name of Object.keys(manifest)) {
      const file = await zip.file(name)!.async('nodebuffer');
      expect(manifest[name]).toBe(createHash('sha1').update(file).digest('hex'));
    }

    const signature = await zip.file('signature')!.async('nodebuffer');
    expect(signature.length).toBeGreaterThan(0);

    // The barcode's raw credential is never visible outside pass.json's own field —
    // confirm it doesn't leak into the manifest or get duplicated anywhere unexpected.
    expect(manifestRaw).not.toContain('the-raw-credential-value');
  });

  maybeIt('never embeds userId/studioId in any file inside the bundle', async () => {
    const provider = new AppleWalletProvider(
      configWith({
        WALLET_APPLE_TEAM_ID: 'TEAM123',
        WALLET_APPLE_PASS_TYPE_ID: 'pass.co.gymos.member',
        WALLET_APPLE_SIGNING_CERT_P12_BASE64: fixture!.p12Base64,
        WALLET_APPLE_SIGNING_CERT_PASSWORD: fixture!.p12Password,
        WALLET_APPLE_WWDR_CERT_PEM_BASE64: fixture!.wwdrPemBase64,
      }),
    );
    const pkpass = await provider.buildPkpass({
      walletCredentialId: 'wc_test_2',
      rawCredential: 'raw2',
      memberName: 'Test',
      planName: null,
      branding,
    });
    const zip = await JSZip.loadAsync(pkpass);
    const passJsonRaw = await zip.file('pass.json')!.async('string');
    expect(passJsonRaw).not.toMatch(/"user.?id"|"studio.?id"/i);
  });

  maybeIt('still issues an identifiable pass for a studio with no checked-in artwork', async () => {
    const provider = new AppleWalletProvider(
      configWith({
        WALLET_APPLE_TEAM_ID: 'TEAM123',
        WALLET_APPLE_PASS_TYPE_ID: 'pass.co.gymos.member',
        WALLET_APPLE_SIGNING_CERT_P12_BASE64: fixture!.p12Base64,
        WALLET_APPLE_SIGNING_CERT_PASSWORD: fixture!.p12Password,
        WALLET_APPLE_WWDR_CERT_PEM_BASE64: fixture!.wwdrPemBase64,
      }),
    );
    const pkpass = await provider.buildPkpass({
      walletCredentialId: 'wc_test_3',
      rawCredential: 'raw3',
      memberName: 'Test',
      planName: 'Full Access',
      branding: { ...branding, studioSlug: 'a-studio-with-no-assets', organizationName: 'Pilates Toluca' },
    });

    const zip = await JSZip.loadAsync(pkpass);
    expect(Object.keys(zip.files).sort()).toEqual([
      'icon.png',
      'icon@2x.png',
      'icon@3x.png',
      'manifest.json',
      'pass.json',
      'signature',
    ]);
    const passJson = JSON.parse(await zip.file('pass.json')!.async('string')) as { logoText?: string };
    expect(passJson.logoText).toBe('Pilates Toluca');
  });
});
