import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { buildWalletCredentialBarcode } from '../wallet-credential.constants';
import type { WalletPassBranding } from '../wallet-pass-branding.resolver';
import {
  buildClassId,
  buildGenericClass,
  buildGenericObject,
  buildObjectId,
  buildSaveJwtPayload,
} from './google-object-builder';
import {
  GOOGLE_OAUTH_TOKEN_URL,
  GOOGLE_WALLET_API_BASE,
  GOOGLE_WALLET_ENV_KEYS,
  GOOGLE_WALLET_SAVE_BASE_URL,
  GOOGLE_WALLET_SCOPE,
  WALLET_GOOGLE_NOT_CONFIGURED_MESSAGE,
} from './google-wallet.constants';

export type FetchLike = typeof fetch;

type GoogleWalletConfig = {
  issuerId: string;
  serviceAccountEmail: string;
  privateKeyPem: string;
};

export type EnsureObjectInput = {
  studioId: string;
  walletCredentialId: string;
  rawCredential: string;
  memberName: string;
  planName: string | null;
  branding: WalletPassBranding;
};

/**
 * Uses this codebase's existing crypto/HTTP primitives (jsonwebtoken — already a dependency
 * for the booking QR — for both the OAuth2 JWT-bearer assertion and the "Add to Wallet" save
 * JWT; native fetch for the two REST calls) rather than the `googleapis` SDK, which pulls in
 * far more than this integration needs.
 */
@Injectable()
export class GoogleWalletProvider {
  private readonly logger = new Logger(GoogleWalletProvider.name);

  /**
   * Not a constructor parameter on purpose: NestJS's DI reflects every constructor param by
   * type, and a function-typed param has no resolvable provider token. A plain field with a
   * default keeps `new GoogleWalletProvider(config)` identical to every other single-dependency
   * service in this codebase, while tests can still override it directly (`provider['fetchImpl'] = ...`).
   */
  private fetchImpl: FetchLike = fetch;

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return GOOGLE_WALLET_ENV_KEYS.every((key) => !!this.config.get<string>(key)?.trim());
  }

  buildClassId(studioId: string): string {
    const cfg = this.requireConfig();
    return buildClassId(cfg.issuerId, studioId);
  }

  buildObjectId(walletCredentialId: string): string {
    const cfg = this.requireConfig();
    return buildObjectId(cfg.issuerId, walletCredentialId);
  }

  /** Idempotent get-or-create for both the studio's class and the member's object. */
  async ensureClassAndObject(input: EnsureObjectInput): Promise<{ objectId: string }> {
    const cfg = this.requireConfig();
    const accessToken = await this.getAccessToken(cfg);

    const classId = buildClassId(cfg.issuerId, input.studioId);
    await this.upsert(
      accessToken,
      `${GOOGLE_WALLET_API_BASE}/genericClass`,
      buildGenericClass({ classId, issuerName: input.branding.organizationName }),
    );

    const objectId = buildObjectId(cfg.issuerId, input.walletCredentialId);
    await this.upsert(
      accessToken,
      `${GOOGLE_WALLET_API_BASE}/genericObject`,
      buildGenericObject({
        objectId,
        classId,
        memberName: input.memberName,
        planName: input.planName,
        barcodeMessage: buildWalletCredentialBarcode(input.rawCredential),
        branding: input.branding,
      }),
    );

    this.logger.log(JSON.stringify({ event: 'wallet.google.object_created', studioId: input.studioId, objectId }));
    return { objectId };
  }

  /**
   * A repeat "Add to Google Wallet" tap never needs the raw credential again — the object
   * already exists durably on Google's servers (created once via ensureClassAndObject), so
   * this just mints a fresh reference-only JWT pointing at it.
   */
  buildSaveUrl(objectId: string): string {
    const cfg = this.requireConfig();
    const payload = buildSaveJwtPayload(cfg.serviceAccountEmail, objectId);
    const token = jwt.sign(payload, cfg.privateKeyPem, { algorithm: 'RS256' });
    this.logger.log(JSON.stringify({ event: 'wallet.google.save_link_generated', objectId }));
    return `${GOOGLE_WALLET_SAVE_BASE_URL}${token}`;
  }

  /**
   * Artifact-backed credential recovery (Phase 3.2): GET genericobject/{resourceId} — a
   * standard, documented Wallet Objects API read using the exact `wallet_object.issuer`
   * scope already requested for object creation, no new permission needed. Returns null
   * (not an error) when the object no longer exists server-side (404) or carries no
   * barcode — the caller treats "nothing to recover from this platform" as a normal,
   * non-fatal outcome, never a hard failure. The caller is responsible for verifying the
   * returned value against WalletCredentialService.resolve() before trusting it.
   */
  async getExistingObjectBarcodeValue(objectId: string): Promise<string | null> {
    const cfg = this.requireConfig();
    const accessToken = await this.getAccessToken(cfg);

    const res = await this.fetchImpl(`${GOOGLE_WALLET_API_BASE}/genericObject/${objectId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`Google Wallet API request failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { barcode?: { value?: unknown } };
    const value = body.barcode?.value;
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  private async getAccessToken(cfg: GoogleWalletConfig): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const assertion = jwt.sign(
      {
        iss: cfg.serviceAccountEmail,
        scope: GOOGLE_WALLET_SCOPE,
        aud: GOOGLE_OAUTH_TOKEN_URL,
        iat: now,
        exp: now + 3600,
      },
      cfg.privateKeyPem,
      { algorithm: 'RS256' },
    );

    const res = await this.fetchImpl(GOOGLE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
    if (!res.ok) {
      throw new Error(`Google OAuth2 token exchange failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { access_token: string };
    return body.access_token;
  }

  /** POST to create; a 409 (already exists) is treated as success — get-or-create semantics. */
  private async upsert(accessToken: string, insertUrl: string, body: unknown): Promise<void> {
    const res = await this.fetchImpl(insertUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok || res.status === 409) {
      return;
    }
    throw new Error(`Google Wallet API request failed: HTTP ${res.status}`);
  }

  private requireConfig(): GoogleWalletConfig {
    if (!this.isConfigured()) {
      throw new ConflictException(WALLET_GOOGLE_NOT_CONFIGURED_MESSAGE);
    }
    const issuerId = this.config.get<string>('WALLET_GOOGLE_ISSUER_ID')!;
    const serviceAccountEmail = this.config.get<string>('WALLET_GOOGLE_SERVICE_ACCOUNT_EMAIL')!;
    const privateKeyPem = Buffer.from(
      this.config.get<string>('WALLET_GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY_BASE64')!,
      'base64',
    ).toString('utf8');
    return { issuerId, serviceAccountEmail, privateKeyPem };
  }
}
