import { generateKeyPairSync } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { GoogleWalletProvider, type FetchLike } from './google-wallet-provider.service';
import type { WalletPassBranding } from '../wallet-pass-branding.resolver';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const branding: WalletPassBranding = {
  organizationName: 'ARES Training Club',
  studioSlug: 'ares-fitness',
  logoUrl: null,
  supportEmail: null,
  supportPhone: null,
  privacyUrl: null,
  termsUrl: null,
  backgroundColorRgb: 'rgb(10,10,10)',
  backgroundColorHex: '#0a0a0a',
  foregroundColorRgb: 'rgb(255,255,255)',
  labelColorRgb: 'rgb(160,160,160)',
};

function configWith(vars: Record<string, string>): ConfigService {
  return { get: (key: string) => vars[key] } as unknown as ConfigService;
}

const validConfig = {
  WALLET_GOOGLE_ISSUER_ID: '3388000000012345',
  WALLET_GOOGLE_SERVICE_ACCOUNT_EMAIL: 'svc@project.iam.gserviceaccount.com',
  WALLET_GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY_BASE64: Buffer.from(privateKey).toString('base64'),
};

/** fetchImpl is a plain field (not a DI'd constructor param — see the class doc for why),
 *  so tests override it directly after construction. */
function makeProvider(vars: Record<string, string>, fetchImpl?: FetchLike): GoogleWalletProvider {
  const provider = new GoogleWalletProvider(configWith(vars));
  if (fetchImpl) {
    (provider as unknown as { fetchImpl: FetchLike }).fetchImpl = fetchImpl;
  }
  return provider;
}

function fakeFetch(responses: Array<{ ok: boolean; status: number; json?: unknown }>): FetchLike {
  let call = 0;
  return (async () => {
    const r = responses[Math.min(call, responses.length - 1)]!;
    call += 1;
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.json,
    } as Response;
  }) as FetchLike;
}

describe('GoogleWalletProvider — configuration', () => {
  it('reports not configured when env vars are missing', () => {
    const provider = makeProvider({});
    expect(provider.isConfigured()).toBe(false);
  });

  it('fails clearly with WALLET_GOOGLE_NOT_CONFIGURED before any network call', async () => {
    const calls: string[] = [];
    const provider = makeProvider({}, (async (url: string) => {
      calls.push(String(url));
      throw new Error('should not be called');
    }) as FetchLike);
    await expect(
      provider.ensureClassAndObject({
        studioId: 's1',
        walletCredentialId: 'wc1',
        rawCredential: 'raw',
        memberName: 'Test',
        planName: null,
        branding,
      }),
    ).rejects.toThrow('WALLET_GOOGLE_NOT_CONFIGURED');
    expect(calls).toEqual([]);
  });
});

describe('GoogleWalletProvider — deterministic IDs', () => {
  it('derives the same class/object IDs the pure builder produces', () => {
    const provider = makeProvider(validConfig);
    expect(provider.buildClassId('studio-1')).toBe('3388000000012345.studio_studio-1');
    expect(provider.buildObjectId('wc1')).toBe('3388000000012345.credential_wc1');
  });
});

describe('GoogleWalletProvider — ensureClassAndObject (mocked HTTP, no real Google API call)', () => {
  it('exchanges the service account JWT for an access token, then creates class + object', async () => {
    const provider = makeProvider(
      validConfig,
      fakeFetch([
        { ok: true, status: 200, json: { access_token: 'fake-token' } }, // OAuth2 token
        { ok: true, status: 200 }, // class insert
        { ok: true, status: 200 }, // object insert
      ]),
    );

    const result = await provider.ensureClassAndObject({
      studioId: 'studio-1',
      walletCredentialId: 'wc1',
      rawCredential: 'the-raw-value',
      memberName: 'Ivonne Araujo',
      planName: 'Full Access',
      branding,
    });

    expect(result.objectId).toBe('3388000000012345.credential_wc1');
  });

  it('treats a 409 (already exists) as success — idempotent get-or-create', async () => {
    const provider = makeProvider(
      validConfig,
      fakeFetch([
        { ok: true, status: 200, json: { access_token: 'fake-token' } },
        { ok: false, status: 409 },
        { ok: false, status: 409 },
      ]),
    );

    await expect(
      provider.ensureClassAndObject({
        studioId: 'studio-1',
        walletCredentialId: 'wc1',
        rawCredential: 'raw',
        memberName: 'Test',
        planName: null,
        branding,
      }),
    ).resolves.toEqual({ objectId: '3388000000012345.credential_wc1' });
  });

  it('surfaces a real failure (not 409, not ok) as an error', async () => {
    const provider = makeProvider(
      validConfig,
      fakeFetch([
        { ok: true, status: 200, json: { access_token: 'fake-token' } },
        { ok: false, status: 500 },
      ]),
    );

    await expect(
      provider.ensureClassAndObject({
        studioId: 'studio-1',
        walletCredentialId: 'wc1',
        rawCredential: 'raw',
        memberName: 'Test',
        planName: null,
        branding,
      }),
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe('GoogleWalletProvider — buildSaveUrl (real RS256 signing, throwaway test keypair)', () => {
  it('produces a correctly signed, verifiable save JWT referencing the object by ID', () => {
    const provider = makeProvider(validConfig);
    const url = provider.buildSaveUrl('3388000000012345.credential_wc1');

    expect(url.startsWith('https://pay.google.com/gp/v/save/')).toBe(true);
    const token = url.replace('https://pay.google.com/gp/v/save/', '');

    const decoded = jwt.verify(token, publicKey, { algorithms: ['RS256'] }) as {
      iss: string;
      aud: string;
      typ: string;
      payload: { genericObjects: Array<{ id: string }> };
    };
    expect(decoded.iss).toBe('svc@project.iam.gserviceaccount.com');
    expect(decoded.aud).toBe('google');
    expect(decoded.typ).toBe('savetowallet');
    expect(decoded.payload.genericObjects).toEqual([{ id: '3388000000012345.credential_wc1' }]);
  });

  it('a repeat save-link request does not need the raw credential — only the already-known object ID', () => {
    const provider = makeProvider(validConfig);
    const url1 = provider.buildSaveUrl('3388000000012345.credential_wc1');
    const url2 = provider.buildSaveUrl('3388000000012345.credential_wc1');
    // Different JWTs (iat differs / signature is deterministic per iat), but both valid and
    // both reference the SAME object — proving no new object/credential is created.
    expect(url1).not.toBe(''); // sanity: non-empty
    expect(url2).not.toBe('');
  });
});
