import { timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  WalletPassMode,
  WalletPassPlatform,
  type WalletCredential,
  type WalletPassArtifact,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { buildWalletPassDisplay, type WalletPassDisplay } from '../access/wallet-access-display';
import { WALLET_ACCESS_SNAPSHOT_SCHEMA_VERSION, type WalletAccessSnapshot } from '../access/wallet-access-snapshot';
import { WalletAccessSnapshotLoader } from '../access/wallet-access-snapshot.loader';
import { AppleWalletProvider } from '../apple/apple-wallet-provider.service';
import { APPLE_DYNAMIC_PASS_TEMPLATE_VERSION, APPLE_PASS_TEMPLATE_VERSION } from '../apple/apple-wallet.constants';
import {
  generatePassAuthenticationToken,
  hashPassAuthenticationToken,
  verifyPassAuthenticationToken,
} from '../apple/passkit-token';
import { extractAuthenticationTokenFromPkpass, extractBarcodeMessageFromPkpass } from '../apple/pkpass-reader';
import { hashWalletCredential, WALLET_CREDENTIAL_PREFIX } from '../wallet-credential.constants';
import { WalletPassBrandingResolver } from '../wallet-pass-branding.resolver';
import { dynamicPassesEnabled, passkitWebServiceUrl } from './wallet-dynamic-pass.config';

export type WalletDynamicPassErrorCode =
  | 'WALLET_DYNAMIC_DISABLED'
  | 'WALLET_APPLE_NOT_CONFIGURED'
  | 'WALLET_DYNAMIC_WEB_SERVICE_URL_MISSING'
  | 'WALLET_DYNAMIC_CREDENTIAL_NOT_FOUND'
  | 'WALLET_DYNAMIC_CREDENTIAL_REVOKED'
  | 'WALLET_DYNAMIC_ARTIFACT_NOT_FOUND'
  | 'WALLET_DYNAMIC_STATIC_TEMPLATE_STALE'
  | 'WALLET_DYNAMIC_NOT_ENROLLED'
  | 'WALLET_DYNAMIC_BARCODE_UNRECOVERABLE'
  | 'WALLET_DYNAMIC_TOKEN_UNRECOVERABLE'
  | 'WALLET_DYNAMIC_CONCURRENT_MODIFICATION';

/** A refusal. Every one leaves the stored artifact exactly as it was. */
export class WalletDynamicPassError extends Error {
  constructor(readonly code: WalletDynamicPassErrorCode) {
    super(code);
    this.name = 'WalletDynamicPassError';
  }
}

export type WalletDynamicPassOutcome = {
  outcome: 'enrolled' | 'updated' | 'unchanged' | 'already_dynamic';
  walletCredentialId: string;
  studioId: string;
  passVersion: number;
  lastModifiedAt: Date | null;
  overall: WalletAccessSnapshot['overall'] | null;
};

export type WalletDynamicPassPreview = {
  walletCredentialId: string;
  studioId: string;
  passMode: WalletPassMode | null;
  snapshot: WalletAccessSnapshot;
  display: WalletPassDisplay;
};

type Loaded = { credential: WalletCredential; artifact: WalletPassArtifact };

/**
 * The content-change timestamp is taken at write time (after signing), not when the build
 * started, and always moves forward by at least 1 ms — it is the cursor devices page updates
 * by, so it must not lag behind the commit it describes or repeat a previous value.
 */
function nextLastModifiedAt(artifact: WalletPassArtifact): Date {
  return new Date(Math.max(Date.now(), (artifact.lastModifiedAt?.getTime() ?? 0) + 1));
}

/**
 * Smart Wallet 2.0, Stage 1A. Builds DYNAMIC Apple passes — the member's existing pass plus a
 * PassKit webServiceURL, a per-pass authenticationToken and a server-computed state display.
 *
 * Invariants (each is a test):
 * - Identity is preserved: same serialNumber (WalletCredential.id), same barcode message,
 *   recovered from the stored pass and verified against the credential's own hash.
 * - The authenticationToken is minted exactly once, at enrollment. Every later build reuses
 *   the token recovered from the stored pass, verified against the stored hash. If it cannot be
 *   recovered and verified, the build FAILS — the token is never silently rotated (Apple
 *   requires it to stay the same for the life of the pass).
 * - Enrollment is explicit and per credential (operator action); nothing here runs on its own
 *   and nothing here ever touches a STATIC artifact except the one being enrolled.
 * - Signing happens outside any transaction; the write is one short guarded UPDATE that only
 *   succeeds if the row is still exactly the version that was read (optimistic concurrency).
 * - A rebuild whose content hash equals the stored one is not a change: no write, no version
 *   bump, nothing for Wallet to download.
 * - Access decisions are untouched: this only changes what the pass SAYS.
 */
@Injectable()
export class WalletDynamicPassService {
  private readonly logger = new Logger(WalletDynamicPassService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly branding: WalletPassBrandingResolver,
    private readonly appleProvider: AppleWalletProvider,
    private readonly accessLoader: WalletAccessSnapshotLoader,
  ) {}

  isEnabled(): boolean {
    return dynamicPassesEnabled(this.config);
  }

  /** Read-only: what the pass would say now. Signs nothing, writes nothing, needs no flag. */
  async preview(walletCredentialId: string, now: Date = new Date()): Promise<WalletDynamicPassPreview> {
    const credential = await this.prisma.walletCredential.findUnique({ where: { id: walletCredentialId } });
    if (!credential) throw new WalletDynamicPassError('WALLET_DYNAMIC_CREDENTIAL_NOT_FOUND');
    const artifact = await this.findAppleArtifact(walletCredentialId);
    const snapshot = await this.accessLoader.compute(credential, now);
    return {
      walletCredentialId,
      studioId: credential.studioId,
      passMode: artifact?.passMode ?? null,
      snapshot,
      display: buildWalletPassDisplay(snapshot),
    };
  }

  /**
   * Converts ONE existing, current-template STATIC Apple artifact into a DYNAMIC pass with the
   * same serial and barcode. The member's device only receives it when the pass is downloaded
   * again (a static pass has no web service to be told about the change).
   */
  async enroll(walletCredentialId: string, now: Date = new Date()): Promise<WalletDynamicPassOutcome> {
    const webServiceURL = this.assertBuildable();
    const { credential, artifact } = await this.load(walletCredentialId);

    if (artifact.passMode === WalletPassMode.DYNAMIC) {
      return this.outcome('already_dynamic', credential, artifact, null);
    }
    if (credential.revokedAt) throw new WalletDynamicPassError('WALLET_DYNAMIC_CREDENTIAL_REVOKED');
    // A stale static artifact is one the static path may still rewrite; enrolling only
    // current-template rows leaves the static path no reason to ever write to this row.
    if (artifact.templateVersion !== APPLE_PASS_TEMPLATE_VERSION) {
      throw new WalletDynamicPassError('WALLET_DYNAMIC_STATIC_TEMPLATE_STALE');
    }

    const rawCredential = await this.recoverRawCredential(credential, artifact);
    const authenticationToken = generatePassAuthenticationToken();
    const snapshot = await this.accessLoader.compute(credential, now);
    const rendered = await this.render(credential, rawCredential, authenticationToken, webServiceURL, snapshot);
    const pkpass = await this.appleProvider.signRenderedPass(rendered);

    const passVersion = artifact.passVersion + 1;
    const writtenAt = nextLastModifiedAt(artifact);
    const { count } = await this.prisma.walletPassArtifact.updateMany({
      where: {
        id: artifact.id,
        passMode: WalletPassMode.STATIC,
        passVersion: artifact.passVersion,
        updatedAt: artifact.updatedAt,
      },
      data: {
        pkpassData: Uint8Array.from(pkpass),
        passMode: WalletPassMode.DYNAMIC,
        dynamicTemplateVersion: APPLE_DYNAMIC_PASS_TEMPLATE_VERSION,
        authenticationTokenHash: hashPassAuthenticationToken(authenticationToken),
        contentHash: rendered.contentHash,
        passVersion,
        lastModifiedAt: writtenAt,
        nextTransitionAt: snapshot.nextTransitionAt ? new Date(snapshot.nextTransitionAt) : null,
        snapshotSchemaVersion: WALLET_ACCESS_SNAPSHOT_SCHEMA_VERSION,
        dynamicEnabledAt: writtenAt,
      },
    });
    if (count !== 1) throw new WalletDynamicPassError('WALLET_DYNAMIC_CONCURRENT_MODIFICATION');

    this.logger.log(
      JSON.stringify({
        event: 'wallet.dynamic.enrolled',
        studioId: credential.studioId,
        walletCredentialId: credential.id,
        passVersion,
        overall: snapshot.overall,
      }),
    );
    return { outcome: 'enrolled', walletCredentialId, studioId: credential.studioId, passVersion, lastModifiedAt: writtenAt, overall: snapshot.overall };
  }

  /**
   * Recomputes a DYNAMIC pass. Re-signs and bumps the version only when the content a member
   * would see changed (or the dynamic template did); otherwise writes nothing.
   */
  async refresh(walletCredentialId: string, now: Date = new Date()): Promise<WalletDynamicPassOutcome> {
    const webServiceURL = this.assertBuildable();
    const { credential, artifact } = await this.load(walletCredentialId);
    if (artifact.passMode !== WalletPassMode.DYNAMIC) {
      throw new WalletDynamicPassError('WALLET_DYNAMIC_NOT_ENROLLED');
    }

    const rawCredential = await this.recoverRawCredential(credential, artifact);
    const authenticationToken = await this.recoverAuthenticationToken(artifact);
    const snapshot = await this.accessLoader.compute(credential, now);
    const rendered = await this.render(credential, rawCredential, authenticationToken, webServiceURL, snapshot);

    if (
      rendered.contentHash === artifact.contentHash &&
      artifact.dynamicTemplateVersion === APPLE_DYNAMIC_PASS_TEMPLATE_VERSION
    ) {
      return this.outcome('unchanged', credential, artifact, snapshot);
    }

    const pkpass = await this.appleProvider.signRenderedPass(rendered);
    const passVersion = artifact.passVersion + 1;
    const writtenAt = nextLastModifiedAt(artifact);
    const { count } = await this.prisma.walletPassArtifact.updateMany({
      where: {
        id: artifact.id,
        passMode: WalletPassMode.DYNAMIC,
        passVersion: artifact.passVersion,
        updatedAt: artifact.updatedAt,
        authenticationTokenHash: artifact.authenticationTokenHash,
      },
      data: {
        pkpassData: Uint8Array.from(pkpass),
        dynamicTemplateVersion: APPLE_DYNAMIC_PASS_TEMPLATE_VERSION,
        contentHash: rendered.contentHash,
        passVersion,
        lastModifiedAt: writtenAt,
        nextTransitionAt: snapshot.nextTransitionAt ? new Date(snapshot.nextTransitionAt) : null,
        snapshotSchemaVersion: WALLET_ACCESS_SNAPSHOT_SCHEMA_VERSION,
      },
    });
    if (count !== 1) throw new WalletDynamicPassError('WALLET_DYNAMIC_CONCURRENT_MODIFICATION');

    this.logger.log(
      JSON.stringify({
        event: 'wallet.dynamic.updated',
        studioId: credential.studioId,
        walletCredentialId: credential.id,
        fromPassVersion: artifact.passVersion,
        passVersion,
        overall: snapshot.overall,
      }),
    );
    return { outcome: 'updated', walletCredentialId, studioId: credential.studioId, passVersion, lastModifiedAt: writtenAt, overall: snapshot.overall };
  }

  private assertBuildable(): string {
    if (!this.isEnabled()) throw new WalletDynamicPassError('WALLET_DYNAMIC_DISABLED');
    if (!this.appleProvider.isConfigured()) throw new WalletDynamicPassError('WALLET_APPLE_NOT_CONFIGURED');
    const url = passkitWebServiceUrl(this.config);
    if (!url) throw new WalletDynamicPassError('WALLET_DYNAMIC_WEB_SERVICE_URL_MISSING');
    return url;
  }

  private async load(walletCredentialId: string): Promise<Loaded> {
    const credential = await this.prisma.walletCredential.findUnique({ where: { id: walletCredentialId } });
    if (!credential) throw new WalletDynamicPassError('WALLET_DYNAMIC_CREDENTIAL_NOT_FOUND');
    const artifact = await this.findAppleArtifact(walletCredentialId);
    if (!artifact?.pkpassData) throw new WalletDynamicPassError('WALLET_DYNAMIC_ARTIFACT_NOT_FOUND');
    return { credential, artifact };
  }

  private findAppleArtifact(walletCredentialId: string): Promise<WalletPassArtifact | null> {
    return this.prisma.walletPassArtifact.findUnique({
      where: { walletCredentialId_platform: { walletCredentialId, platform: WalletPassPlatform.APPLE } },
    });
  }

  /**
   * The raw credential embedded in the stored pass, accepted only if its SHA-256 equals the
   * credential row's own hash (the same primitive check-in resolution uses). Works for a
   * revoked credential too, so its pass can still be updated to say it was replaced.
   */
  private async recoverRawCredential(credential: WalletCredential, artifact: WalletPassArtifact): Promise<string> {
    let message: string;
    try {
      message = await extractBarcodeMessageFromPkpass(Buffer.from(artifact.pkpassData!));
    } catch {
      throw this.failClosed('WALLET_DYNAMIC_BARCODE_UNRECOVERABLE', credential);
    }
    if (!message.startsWith(WALLET_CREDENTIAL_PREFIX)) {
      throw this.failClosed('WALLET_DYNAMIC_BARCODE_UNRECOVERABLE', credential);
    }
    const raw = message.slice(WALLET_CREDENTIAL_PREFIX.length);
    const presented = Buffer.from(hashWalletCredential(raw), 'hex');
    const expected = Buffer.from(credential.credentialHash, 'hex');
    if (presented.length !== expected.length || presented.length === 0 || !timingSafeEqual(presented, expected)) {
      throw this.failClosed('WALLET_DYNAMIC_BARCODE_UNRECOVERABLE', credential);
    }
    return raw;
  }

  /** Never rotates: an unrecoverable or mismatching token stops the build. */
  private async recoverAuthenticationToken(artifact: WalletPassArtifact): Promise<string> {
    let token: string | null;
    try {
      token = await extractAuthenticationTokenFromPkpass(Buffer.from(artifact.pkpassData!));
    } catch {
      token = null;
    }
    if (!token || !verifyPassAuthenticationToken(token, artifact.authenticationTokenHash)) {
      this.logger.error(
        JSON.stringify({
          event: 'wallet.dynamic.token_unrecoverable',
          walletCredentialId: artifact.walletCredentialId,
          passVersion: artifact.passVersion,
        }),
      );
      throw new WalletDynamicPassError('WALLET_DYNAMIC_TOKEN_UNRECOVERABLE');
    }
    return token;
  }

  private async render(
    credential: WalletCredential,
    rawCredential: string,
    authenticationToken: string,
    webServiceURL: string,
    snapshot: WalletAccessSnapshot,
  ) {
    const branding = await this.branding.resolve(credential.studioId);
    return this.appleProvider.renderDynamicPass({
      walletCredentialId: credential.id,
      rawCredential,
      memberName: snapshot.memberDisplayName,
      branding,
      webServiceURL,
      authenticationToken,
      display: buildWalletPassDisplay(snapshot),
    });
  }

  private failClosed(code: WalletDynamicPassErrorCode, credential: WalletCredential): WalletDynamicPassError {
    this.logger.error(JSON.stringify({ event: 'wallet.dynamic.refused', code, studioId: credential.studioId, walletCredentialId: credential.id }));
    return new WalletDynamicPassError(code);
  }

  private outcome(
    outcome: WalletDynamicPassOutcome['outcome'],
    credential: WalletCredential,
    artifact: WalletPassArtifact,
    snapshot: WalletAccessSnapshot | null,
  ): WalletDynamicPassOutcome {
    return {
      outcome,
      walletCredentialId: credential.id,
      studioId: credential.studioId,
      passVersion: artifact.passVersion,
      lastModifiedAt: artifact.lastModifiedAt,
      overall: snapshot?.overall ?? null,
    };
  }
}
