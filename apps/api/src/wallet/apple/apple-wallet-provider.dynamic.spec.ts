import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import JSZip from 'jszip';
import type { WalletPassDisplay } from '../access/wallet-access-display';
import type { WalletPassBranding } from '../wallet-pass-branding.resolver';
import { AppleWalletProvider } from './apple-wallet-provider.service';
import { buildPassJson } from './pkpass-builder';
import { generatePassAuthenticationToken } from './passkit-token';
import { extractAuthenticationTokenFromPkpass, extractBarcodeMessageFromPkpass } from './pkpass-reader';
import { generateTestApplePkiFixture } from './test-cert-fixture';

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

const display: WalletPassDisplay = {
  status: { key: 'status', label: 'ESTADO', value: 'VENCIDA' },
  plan: { key: 'plan', label: 'PLAN', value: 'Full Access' },
  validity: { key: 'validity', label: 'VIGENCIA', value: 'Venció el 9 oct 2026' },
  scope: null,
  details: [{ key: 'membership_1', label: 'FULL ACCESS', value: 'Vencida · Venció el 9 oct 2026' }],
  voided: false,
};

const fixture = generateTestApplePkiFixture();
const maybeDescribe = fixture ? describe : describe.skip;

function providerWithFixture(): AppleWalletProvider {
  const vars: Record<string, string> = {
    WALLET_APPLE_TEAM_ID: 'TEAM123',
    WALLET_APPLE_PASS_TYPE_ID: 'pass.co.gymos.member.test',
    WALLET_APPLE_SIGNING_CERT_P12_BASE64: fixture!.p12Base64,
    WALLET_APPLE_SIGNING_CERT_PASSWORD: fixture!.p12Password,
    WALLET_APPLE_WWDR_CERT_PEM_BASE64: fixture!.wwdrPemBase64,
  };
  return new AppleWalletProvider({ get: (key: string) => vars[key] } as unknown as ConfigService);
}

/** openssl verification of the detached PKCS#7 signature over manifest.json, chained to the test WWDR. */
function verifyDetachedSignature(signature: Buffer, manifest: Buffer, wwdrPem: string): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'gymos-pkpass-verify-'));
  try {
    writeFileSync(join(dir, 'signature'), signature);
    writeFileSync(join(dir, 'manifest.json'), manifest);
    writeFileSync(join(dir, 'wwdr.pem'), wwdrPem);
    execFileSync(
      'openssl',
      ['smime', '-verify', '-binary', '-inform', 'DER', '-in', 'signature', '-content', 'manifest.json', '-CAfile', 'wwdr.pem', '-purpose', 'any', '-out', '/dev/null'],
      { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function unzip(pkpass: Buffer) {
  const zip = await JSZip.loadAsync(pkpass);
  const files: Record<string, Buffer> = {};
  for (const name of Object.keys(zip.files)) {
    files[name] = await zip.file(name)!.async('nodebuffer');
  }
  return files;
}

maybeDescribe('AppleWalletProvider — dynamic pass signing (throwaway test PKI, no Apple credentials)', () => {
  const wwdrPem = Buffer.from(fixture?.wwdrPemBase64 ?? '', 'base64').toString('utf8');
  const token = generatePassAuthenticationToken();

  it('reports the signing certificate validity for expiry monitoring (no secret material)', () => {
    const info = providerWithFixture().signingCertificateInfo();
    expect(info.notAfter.getTime() - info.notBefore.getTime()).toBe(24 * 60 * 60 * 1000); // the fixture is a 1-day cert
    expect(info.notAfter.getTime()).toBeGreaterThan(Date.now());
    // The throwaway fixture only carries a CN; real Pass Type ID certificates carry UID and OU.
    expect(info.passTypeIdentifier).toBeNull();
    expect(info.teamIdentifier).toBeNull();
    expect(info.serialNumber).toMatch(/^[0-9a-f]+$/i);
    expect(JSON.stringify(info)).not.toMatch(/PRIVATE KEY|BEGIN CERTIFICATE/);
  });

  it('produces a correctly signed .pkpass whose manifest matches every packaged file', async () => {
    const provider = providerWithFixture();
    const rendered = provider.renderDynamicPass({
      walletCredentialId: 'wc_dynamic_1',
      rawCredential: 'the-raw-credential-value',
      memberName: 'Ana Prueba',
      branding,
      webServiceURL: 'https://api.example.test/api/v1/wallet/passkit',
      authenticationToken: token,
      display,
    });
    const pkpass = await provider.signRenderedPass(rendered);
    const files = await unzip(pkpass);

    expect(Object.keys(files).sort()).toEqual([
      'icon.png', 'icon@2x.png', 'icon@3x.png', 'logo.png', 'logo@2x.png', 'logo@3x.png', 'manifest.json', 'pass.json', 'signature',
    ]);
    const manifest = JSON.parse(files['manifest.json']!.toString('utf8')) as Record<string, string>;
    expect(Object.keys(manifest).sort()).toEqual(Object.keys(files).filter((n) => n !== 'manifest.json' && n !== 'signature').sort());
    for (const [name, sha1] of Object.entries(manifest)) {
      expect(createHash('sha1').update(files[name]!).digest('hex')).toBe(sha1);
    }
    expect(verifyDetachedSignature(files['signature']!, files['manifest.json']!, wwdrPem)).toBe(true);
    // A tampered manifest must not verify (proves the check above is meaningful).
    expect(verifyDetachedSignature(files['signature']!, Buffer.concat([files['manifest.json']!, Buffer.from(' ')]), wwdrPem)).toBe(false);

    const passJson = JSON.parse(files['pass.json']!.toString('utf8')) as Record<string, unknown>;
    expect(passJson).toMatchObject({
      serialNumber: 'wc_dynamic_1',
      passTypeIdentifier: 'pass.co.gymos.member.test',
      teamIdentifier: 'TEAM123',
      webServiceURL: 'https://api.example.test/api/v1/wallet/passkit',
      authenticationToken: token,
    });
    expect(passJson).not.toHaveProperty('voided');
    expect(await extractBarcodeMessageFromPkpass(pkpass)).toBe('gymos:v1:the-raw-credential-value');
    expect(await extractAuthenticationTokenFromPkpass(pkpass)).toBe(token);
  });

  it('the content hash identifies content, not the signature: two signings, one hash', async () => {
    const provider = providerWithFixture();
    const input = {
      walletCredentialId: 'wc_dynamic_1',
      rawCredential: 'the-raw-credential-value',
      memberName: 'Ana Prueba',
      branding,
      webServiceURL: 'https://api.example.test/api/v1/wallet/passkit',
      authenticationToken: token,
      display,
    };
    const a = provider.renderDynamicPass(input);
    const b = provider.renderDynamicPass(input);
    expect(a.contentHash).toBe(b.contentHash);
    const [pa, pb] = await Promise.all([provider.signRenderedPass(a), provider.signRenderedPass(b)]);
    const [fa, fb] = await Promise.all([unzip(pa), unzip(pb)]);
    expect(fa['pass.json']!.equals(fb['pass.json']!)).toBe(true);
    expect(fa['manifest.json']!.equals(fb['manifest.json']!)).toBe(true);
  });

  it('static compatibility: the static pass is unchanged by the shared signing refactor', async () => {
    const provider = providerWithFixture();
    const pkpass = await provider.buildPkpass({
      walletCredentialId: 'wc_static_1',
      rawCredential: 'the-raw-credential-value',
      memberName: 'Ana Prueba',
      planName: 'Full Access',
      branding,
    });
    const files = await unzip(pkpass);
    const passJson = JSON.parse(files['pass.json']!.toString('utf8')) as Record<string, unknown>;

    // Byte-for-byte the same pass.json the pure static builder produces for these inputs...
    const expected = buildPassJson({
      passTypeIdentifier: 'pass.co.gymos.member.test',
      teamIdentifier: 'TEAM123',
      serialNumber: 'wc_static_1',
      organizationName: 'ARES Training Club',
      memberName: 'Ana Prueba',
      planName: 'Full Access',
      barcodeMessage: 'gymos:v1:the-raw-credential-value',
      backgroundColorRgb: 'rgb(10,10,10)',
      foregroundColorRgb: 'rgb(255,255,255)',
      labelColorRgb: 'rgb(160,160,160)',
      supportEmail: 'hola@ares.mx',
      termsUrl: 'https://ares.mx/terminos',
      hasLogoImage: true,
    });
    expect(files['pass.json']!.toString('utf8')).toBe(JSON.stringify(expected));
    // ...with no web service, token or state of any kind.
    for (const key of ['webServiceURL', 'authenticationToken', 'voided', 'expirationDate', 'relevantDate']) {
      expect(passJson).not.toHaveProperty(key);
    }
    expect(verifyDetachedSignature(files['signature']!, files['manifest.json']!, wwdrPem)).toBe(true);
    await expect(extractAuthenticationTokenFromPkpass(pkpass)).resolves.toBeNull();
  });
});
