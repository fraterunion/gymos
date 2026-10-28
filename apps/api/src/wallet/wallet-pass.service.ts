import { ConflictException, ForbiddenException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WalletPassMode, WalletPassPlatform, type WalletCredential, type WalletPassArtifact } from '@prisma/client';
import * as jwt from 'jsonwebtoken';
import { PrismaService } from '../prisma/prisma.service';
import { buildWalletCredentialBarcode, WALLET_CREDENTIAL_PREFIX } from './wallet-credential.constants';
import { WalletCredentialService } from './wallet-credential.service';
import { WalletPassBrandingResolver } from './wallet-pass-branding.resolver';
import {
  WALLET_DOWNLOAD_TOKEN_INVALID_MESSAGE,
  WALLET_MEMBER_NOT_ACTIVE_MESSAGE,
  WALLET_PASS_REISSUE_REQUIRED_MESSAGE,
  WALLET_RECOVERY_INTEGRITY_ERROR_MESSAGE,
} from './wallet-pass.constants';
import { AppleWalletProvider } from './apple/apple-wallet-provider.service';
import { APPLE_PASS_TEMPLATE_VERSION, WALLET_APPLE_NOT_CONFIGURED_MESSAGE } from './apple/apple-wallet.constants';
import { extractBarcodeMessageFromPkpass } from './apple/pkpass-reader';
import { GoogleWalletProvider } from './google/google-wallet-provider.service';
import { WALLET_GOOGLE_NOT_CONFIGURED_MESSAGE } from './google/google-wallet.constants';
import { resolveEntitledPrimaryPlanName } from './access/wallet-access-snapshot';
import { WalletAccessSnapshotLoader } from './access/wallet-access-snapshot.loader';
import { WalletDynamicPassService } from './dynamic/wallet-dynamic-pass.service';
import { isAutoEnrollmentEligible } from './dynamic/wallet-auto-enrollment.config';

type MemberContext = { memberName: string; planName: string | null };

const APPLE_DOWNLOAD_TOKEN_TTL_SECONDS = 90;

/**
 * A persisted .pkpass is served verbatim, so it keeps whatever presentation it was signed
 * with until something explicitly invalidates it. `null` covers rows written before
 * versioning existed and is therefore stale by definition.
 *
 * A DYNAMIC artifact (Smart Wallet 2.0) is never stale here: it is versioned by its own
 * dynamicTemplateVersion and rebuilt only by WalletDynamicPassService, which preserves its
 * PassKit authenticationToken. Rebuilding it as a static pass would strip the web service and
 * the token from the stored pass and leave the installed one unable to update.
 */
export function isStaleAppleArtifact(artifact: WalletPassArtifact): boolean {
  if (artifact.passMode === WalletPassMode.DYNAMIC) return false;
  return artifact.templateVersion !== APPLE_PASS_TEMPLATE_VERSION;
}

type AppleDownloadTokenPayload = {
  sub: string;
  studioId: string;
  walletCredentialId: string;
  purpose: 'apple-pkpass-download';
};

function isAppleDownloadTokenPayload(v: jwt.JwtPayload | string): v is AppleDownloadTokenPayload & jwt.JwtPayload {
  if (typeof v === 'string' || v === null || typeof v !== 'object') return false;
  return (
    typeof v['sub'] === 'string' &&
    typeof v['studioId'] === 'string' &&
    typeof v['walletCredentialId'] === 'string' &&
    v['purpose'] === 'apple-pkpass-download'
  );
}

@Injectable()
export class WalletPassService {
  private readonly logger = new Logger(WalletPassService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly walletCredentials: WalletCredentialService,
    private readonly branding: WalletPassBrandingResolver,
    private readonly appleProvider: AppleWalletProvider,
    private readonly googleProvider: GoogleWalletProvider,
    private readonly accessLoader: WalletAccessSnapshotLoader,
    private readonly dynamicPasses: WalletDynamicPassService,
  ) {}

  /**
   * The raw "gymos:v1:<raw>" barcode for the member's own in-app QR — the SAME identity
   * Apple/Google Wallet represent, never a second credential system. Returned as JSON over
   * an authenticated request, same trust model as the existing booking-QR endpoint
   * (POST bookings/:id/qr already does exactly this for a different credential type).
   *
   * PHASE 3.2: when raw isn't available locally (existing credential, this device/session
   * never received it — a second device, a reinstall, a lost SecureStore entry), this no
   * longer immediately gives up. It attempts artifact-backed recovery first — reading the
   * SAME raw value back out of an already-provisioned Apple .pkpass or Google GenericObject,
   * both of which already embed it (see recoverBarcode's doc). Only when NEITHER platform
   * has ever been provisioned does this return `barcode: null` — the genuinely unrecoverable
   * case, where the mobile client must show "Actualizar pase," not a routine one.
   */
  async getBarcode(studioId: string, userId: string): Promise<{ barcode: string | null; isNew: boolean }> {
    const { credential, rawCredential } = await this.resolveIssuableCredential(studioId, userId);

    if (rawCredential) {
      // Viewing Mi Pase — even without tapping either Wallet button — is itself the first
      // moment raw exists; provision both platforms now so the buttons work immediately.
      await Promise.all([
        this.tryProvisionApple(credential.id, rawCredential, studioId, userId),
        this.tryProvisionGoogle(credential.id, rawCredential, studioId, userId),
      ]);
      await this.tryFirstIssuanceDynamicEnrollment(credential.id, studioId, userId);
      return { barcode: buildWalletCredentialBarcode(rawCredential), isNew: true };
    }

    const recovered = await this.recoverBarcode(credential, studioId, userId);
    return { barcode: recovered, isNew: false };
  }

  /**
   * Artifact-backed recovery: an already-provisioned Apple .pkpass embeds the full
   * "gymos:v1:<raw>" barcode value in plaintext in pass.json (see pkpass-reader.ts — the
   * PKCS#7 signature proves authenticity/integrity, it does not encrypt the content), and an
   * already-provisioned Google GenericObject embeds the identical value server-side,
   * retrievable via a standard authenticated GET. Both are literally what the member's
   * already-added Wallet pass already contains — reading it back is not a new exposure
   * relative to having provisioned the pass at all (Phase 3.1's threat-model finding).
   *
   * Never trusts artifact contents merely because a row exists: every candidate is run
   * through validateRecoveredBarcode, which reuses WalletCredentialService.resolve() — the
   * exact same verification primitive Wallet check-in scanning uses — rather than a second,
   * parallel implementation. If both platforms independently recover a value, they are
   * checked for exact agreement; disagreement is logged as a distinct integrity signal and
   * never silently resolved by picking one side.
   *
   * On a successful recovery, opportunistically backfills whichever platform artifact was
   * still missing (e.g. Google was down the first time Mi Pase was ever opened) using the
   * now-recovered raw value — the same best-effort tryProvision* helpers first-ever issuance
   * uses, so a member never has to notice or care which platform failed and when.
   */
  private async recoverBarcode(
    credential: WalletCredential,
    studioId: string,
    userId: string,
  ): Promise<string | null> {
    const [appleRecovered, googleRecovered] = await Promise.all([
      this.tryRecoverAppleBarcode(credential),
      this.tryRecoverGoogleBarcode(credential),
    ]);

    if (appleRecovered && googleRecovered && appleRecovered !== googleRecovered) {
      this.logger.error(
        JSON.stringify({
          event: 'wallet.recovery.integrity_mismatch',
          studioId,
          walletCredentialId: credential.id,
        }),
      );
      throw new ConflictException(WALLET_RECOVERY_INTEGRITY_ERROR_MESSAGE);
    }

    const recovered = appleRecovered ?? googleRecovered;
    if (!recovered) {
      return null;
    }

    this.logger.log(
      JSON.stringify({
        event: 'wallet.recovery.succeeded',
        studioId,
        walletCredentialId: credential.id,
        source: appleRecovered ? 'apple' : 'google',
      }),
    );

    // Best-effort backfill of whichever platform didn't already have an artifact — never
    // blocks the response; a failure here just means that platform stays un-provisioned
    // until the member taps its Wallet button directly (same as any other provisioning
    // failure).
    const rawCredential = recovered.slice(WALLET_CREDENTIAL_PREFIX.length);
    await Promise.all([
      this.tryProvisionApple(credential.id, rawCredential, studioId, userId),
      this.tryProvisionGoogle(credential.id, rawCredential, studioId, userId),
    ]);

    return recovered;
  }

  private async tryRecoverAppleBarcode(credential: WalletCredential): Promise<string | null> {
    const artifact = await this.findArtifact(credential.id, WalletPassPlatform.APPLE);
    if (!artifact?.pkpassData) {
      return null;
    }
    try {
      const message = await extractBarcodeMessageFromPkpass(Buffer.from(artifact.pkpassData));
      return await this.validateRecoveredBarcode(message, credential);
    } catch (e) {
      this.logger.warn(
        JSON.stringify({
          event: 'wallet.recovery.apple_extract_failed',
          walletCredentialId: credential.id,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
      return null;
    }
  }

  private async tryRecoverGoogleBarcode(credential: WalletCredential): Promise<string | null> {
    const artifact = await this.findArtifact(credential.id, WalletPassPlatform.GOOGLE);
    if (!artifact?.googleObjectId || !this.googleProvider.isConfigured()) {
      return null;
    }
    try {
      const value = await this.googleProvider.getExistingObjectBarcodeValue(artifact.googleObjectId);
      if (!value) {
        return null;
      }
      return await this.validateRecoveredBarcode(value, credential);
    } catch (e) {
      this.logger.warn(
        JSON.stringify({
          event: 'wallet.recovery.google_fetch_failed',
          walletCredentialId: credential.id,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
      return null;
    }
  }

  /**
   * Reuses the exact canonical verification WalletCredentialService.resolve() already
   * performs for Wallet check-in scanning: format check, SHA-256 hash lookup, revoked-status
   * check. A recovered value is only trusted if it independently re-resolves to the SAME
   * non-revoked credential row we started from — same id, same studio, same member. Never
   * logs the candidate value itself, only IDs.
   */
  private async validateRecoveredBarcode(
    candidate: string,
    expectedCredential: WalletCredential,
  ): Promise<string | null> {
    const resolution = await this.walletCredentials.resolve(candidate);
    if (resolution.status !== 'active') {
      return null;
    }
    const resolved = resolution.credential;
    if (
      resolved.id !== expectedCredential.id ||
      resolved.studioId !== expectedCredential.studioId ||
      resolved.userId !== expectedCredential.userId
    ) {
      this.logger.error(
        JSON.stringify({
          event: 'wallet.recovery.artifact_mismatch',
          expectedWalletCredentialId: expectedCredential.id,
          resolvedWalletCredentialId: resolved.id,
        }),
      );
      return null;
    }
    return candidate;
  }

  /**
   * Mints a short-lived (90s), single-purpose token so the mobile app can open the pkpass
   * download in an in-app browser (expo-web-browser / SFSafariViewController) — content-type
   * sniffing is what triggers the native "Add to Apple Wallet" sheet, and that requires a
   * plain GET URL Safari can fetch itself; it cannot attach the member's Bearer JWT. The
   * token is deliberately NOT the wallet credential and grants nothing beyond "fetch this one
   * already-authorized pkpass, briefly" — the same class of primitive as the existing 5-minute
   * booking-QR JWT, reused for a different narrow purpose, not a new security model.
   */
  async createAppleDownloadUrl(studioId: string, userId: string, apiBaseUrl: string): Promise<string> {
    // Ensures the artifact exists (provisions if this is the very first request) before
    // minting a token for it — a token pointing at nothing would be a confusing dead end.
    await this.getApplePass(studioId, userId);
    const { credential } = await this.resolveIssuableCredential(studioId, userId);

    const secret = this.config.getOrThrow<string>('JWT_QR_SECRET');
    const token = jwt.sign(
      { sub: userId, studioId, walletCredentialId: credential.id, purpose: 'apple-pkpass-download' },
      secret,
      { expiresIn: APPLE_DOWNLOAD_TOKEN_TTL_SECONDS, algorithm: 'HS256' },
    );
    return `${apiBaseUrl}/studios/${studioId}/wallet/apple/download/${token}`;
  }

  /** Resolves a download token minted by createAppleDownloadUrl back to pkpass bytes. */
  async resolveAppleDownloadToken(studioId: string, token: string): Promise<Buffer> {
    let payload: AppleDownloadTokenPayload;
    try {
      const secret = this.config.getOrThrow<string>('JWT_QR_SECRET');
      const verified = jwt.verify(token, secret, { algorithms: ['HS256'] });
      if (!isAppleDownloadTokenPayload(verified)) {
        throw new UnauthorizedException(WALLET_DOWNLOAD_TOKEN_INVALID_MESSAGE);
      }
      payload = verified;
    } catch (e) {
      if (e instanceof UnauthorizedException) throw e;
      throw new UnauthorizedException(WALLET_DOWNLOAD_TOKEN_INVALID_MESSAGE);
    }
    if (payload.studioId !== studioId) {
      throw new UnauthorizedException(WALLET_DOWNLOAD_TOKEN_INVALID_MESSAGE);
    }
    const artifact = await this.findArtifact(payload.walletCredentialId, WalletPassPlatform.APPLE);
    if (!artifact?.pkpassData) {
      throw new UnauthorizedException(WALLET_DOWNLOAD_TOKEN_INVALID_MESSAGE);
    }
    return Buffer.from(artifact.pkpassData);
  }

  /**
   * Returns the signed .pkpass bytes for this member's own credential. A pre-existing
   * credential with no Apple artifact and no raw value available throws
   * WALLET_PASS_REISSUE_REQUIRED rather than silently reissuing (re-download must never
   * invalidate a legitimate existing pass on another platform/device).
   */
  async getApplePass(studioId: string, userId: string): Promise<Buffer> {
    // Checked before the artifact/raw-credential branch below: an unconfigured provider must
    // always report WALLET_APPLE_NOT_CONFIGURED, never REISSUE_REQUIRED. Without this order,
    // getBarcode's eager background provisioning (best-effort, silently skips when
    // unconfigured) already consumes the one-time raw credential on the member's very first
    // Mi Pase view, so this method would see "no artifact, no raw" on every later tap and
    // misreport a routine "not set up yet" as an alarming reissue requirement.
    if (!this.appleProvider.isConfigured()) {
      throw new ConflictException(WALLET_APPLE_NOT_CONFIGURED_MESSAGE);
    }
    const { credential, rawCredential } = await this.resolveIssuableCredential(studioId, userId);

    let artifact = await this.findArtifact(credential.id, WalletPassPlatform.APPLE);
    if (!artifact) {
      if (!rawCredential) {
        throw new ConflictException(WALLET_PASS_REISSUE_REQUIRED_MESSAGE);
      }
      artifact = await this.provisionApple(credential.id, rawCredential, studioId, userId);
      // Direct Apple request as first contact: enroll before returning installable bytes.
      await this.tryFirstIssuanceDynamicEnrollment(credential.id, studioId, userId);
      artifact = (await this.findArtifact(credential.id, WalletPassPlatform.APPLE)) ?? artifact;
    } else if (isStaleAppleArtifact(artifact)) {
      artifact = await this.refreshStaleAppleArtifact(artifact, credential, rawCredential, studioId, userId);
    }

    if (rawCredential) {
      // Best-effort: pre-provision the OTHER platform too while raw is still available, so a
      // later "Add to Google Wallet" tap never needs it again. Never blocks this response.
      await this.tryProvisionGoogle(credential.id, rawCredential, studioId, userId);
    }

    return Buffer.from(artifact.pkpassData!);
  }

  /** Mirrors getApplePass for Google — see class doc. */
  async getGooglePass(studioId: string, userId: string): Promise<{ saveUrl: string }> {
    // See getApplePass for why this check comes first — same eager-provisioning interaction.
    if (!this.googleProvider.isConfigured()) {
      throw new ConflictException(WALLET_GOOGLE_NOT_CONFIGURED_MESSAGE);
    }
    const { credential, rawCredential } = await this.resolveIssuableCredential(studioId, userId);

    let artifact = await this.findArtifact(credential.id, WalletPassPlatform.GOOGLE);
    if (!artifact) {
      if (!rawCredential) {
        throw new ConflictException(WALLET_PASS_REISSUE_REQUIRED_MESSAGE);
      }
      artifact = await this.provisionGoogle(credential.id, rawCredential, studioId, userId);
    }

    if (rawCredential) {
      await this.tryProvisionApple(credential.id, rawCredential, studioId, userId);
      // Even if Google is requested first, do not leave an allowlisted new Apple pass static.
      await this.tryFirstIssuanceDynamicEnrollment(credential.id, studioId, userId);
    }

    return { saveUrl: this.googleProvider.buildSaveUrl(artifact.googleObjectId!) };
  }

  /**
   * The correct way to perform a security reissue (lost phone, compromised pass, explicit
   * member reset) when a working in-app QR is needed immediately afterward. Revokes the old
   * credential (old Apple/Google barcodes stop resolving at the very next check-in scan —
   * Phase 1's revoked-credential path, unchanged) and eagerly provisions both platforms with
   * the new raw value while it's still available, exactly like first-ever issuance does.
   *
   * PHASE 3.2 atomicity fix: credential rotation (`walletCredentials.reissue`, already its
   * own DB transaction) and provider provisioning are different failure domains — see
   * Part F, providers are convenience representations of the identity, not the identity
   * itself. Previously, an unconfigured/failing Apple provider threw straight out of this
   * method AFTER the old credential had already been revoked, leaving the member with
   * NO usable credential at all (old gone, new one stuck mid-provision). Now provisioning
   * runs through the same best-effort tryProvisionApple/tryProvisionGoogle helpers
   * getBarcode's eager dual-provisioning already uses — a provider failure here can never
   * prevent returning a working barcode for the in-app QR, which needs no provider at all.
   *
   * Calling `WalletCredentialService.reissue()` directly (bypassing this) and then a plain
   * getApplePass()/getGooglePass() afterward is NOT equivalent: issue() would find the new
   * row already exists and correctly refuse to hand back a second raw value, surfacing
   * WALLET_PASS_REISSUE_REQUIRED — technically correct, but confusing immediately after a
   * reissue the caller just performed. This method exists so that gap has one clean answer.
   */
  async reissueAndProvision(
    studioId: string,
    userId: string,
  ): Promise<{ barcode: string; applePkpassAvailable: boolean; googleWalletAvailable: boolean }> {
    const membership = await this.prisma.studioMembership.findFirst({
      where: { studioId, userId, deletedAt: null },
      select: { user: { select: { deletedAt: true } } },
    });
    if (!membership || membership.user.deletedAt) {
      throw new ForbiddenException(WALLET_MEMBER_NOT_ACTIVE_MESSAGE);
    }

    // Everything above this line is read-only. The instant reissue() returns, the old
    // credential is gone and the new one exists — that transaction is the only part of this
    // operation that must be all-or-nothing, and it already is. Nothing below this line may
    // ever throw in a way that leaves the member worse off than "barcode works, Wallet
    // buttons might need a retry."
    const { credential, rawCredential } = await this.walletCredentials.reissue(studioId, userId);
    const barcode = buildWalletCredentialBarcode(rawCredential);

    await Promise.all([
      this.tryProvisionApple(credential.id, rawCredential, studioId, userId),
      this.tryProvisionGoogle(credential.id, rawCredential, studioId, userId),
    ]);

    const [appleArtifact, googleArtifact] = await Promise.all([
      this.findArtifact(credential.id, WalletPassPlatform.APPLE),
      this.findArtifact(credential.id, WalletPassPlatform.GOOGLE),
    ]);

    return {
      barcode,
      applePkpassAvailable: !!appleArtifact?.pkpassData,
      googleWalletAvailable: !!googleArtifact?.googleObjectId,
    };
  }

  /**
   * Stage 4B is opt-in for explicitly allowlisted first issuances ONLY.
   * Never rewrite an existing Apple pass when an old credential is re-opened.
   * If enrolling fails, preserve and serve the already-valid static pass.
   */
  private async tryFirstIssuanceDynamicEnrollment(
    walletCredentialId: string,
    studioId: string,
    userId: string,
  ): Promise<void> {
    if (!isAutoEnrollmentEligible(this.config, studioId, userId) || !this.dynamicPasses.isEnabled()) return;
    try {
      const artifact = await this.findArtifact(walletCredentialId, WalletPassPlatform.APPLE);
      if (!artifact || artifact.passMode === WalletPassMode.DYNAMIC) return;
      await this.dynamicPasses.enroll(walletCredentialId);
    } catch (error) {
      this.logger.warn(JSON.stringify({
        event: 'wallet.auto_enroll.fallback_static',
        studioId,
        walletCredentialId,
        errorCode: error instanceof Error ? error.name : 'UNKNOWN',
      }));
    }
  }

  private async resolveIssuableCredential(studioId: string, userId: string) {
    // Pass ISSUANCE eligibility mirrors Phase 1 check-in resolution exactly: an active,
    // non-deleted StudioMembership is required; current billing/subscription entitlement is
    // NOT — a lapsed entitlement must not destroy the identity credential (Phase 1 principle,
    // unchanged here). Live check-in authorization remains the only access decision.
    const membership = await this.prisma.studioMembership.findFirst({
      where: { studioId, userId, deletedAt: null },
      select: { user: { select: { deletedAt: true } } },
    });
    if (!membership || membership.user.deletedAt) {
      throw new ForbiddenException(WALLET_MEMBER_NOT_ACTIVE_MESSAGE);
    }
    return this.walletCredentials.issue(studioId, userId);
  }

  private async findArtifact(
    walletCredentialId: string,
    platform: WalletPassPlatform,
  ): Promise<WalletPassArtifact | null> {
    return this.prisma.walletPassArtifact.findUnique({
      where: { walletCredentialId_platform: { walletCredentialId, platform } },
    });
  }

  /**
   * The plan named on a newly built static pass is the canonical PRIMARY membership the member
   * is ENTITLED to right now (deriveMembershipLifecycle + selectPrimaryMembership — the same
   * rules check-in and booking use), or none. It used to be the newest row whose stored status
   * was ACTIVE/TRIALING, which kept naming a cash plan after its paid period had ended (cash
   * rows keep status ACTIVE past their end date), skipped CANCELED rows still inside a paid
   * window, and picked the newest row rather than the CORE membership.
   *
   * Only passes built from now on are affected: a stored .pkpass is served verbatim and
   * APPLE_PASS_TEMPLATE_VERSION is unchanged, so no existing artifact is rebuilt by this.
   */
  private async loadMemberContext(studioId: string, userId: string): Promise<MemberContext> {
    const [user, subscriptions] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { firstName: true, lastName: true },
      }),
      this.accessLoader.loadSubscriptions(studioId, userId),
    ]);
    return {
      memberName: `${user.firstName} ${user.lastName}`.trim(),
      planName: resolveEntitledPrimaryPlanName(subscriptions, new Date()),
    };
  }

  /**
   * Rebuilds a pass whose presentation is out of date, reusing the SAME WalletCredential.
   *
   * This is a visual refresh, not a security operation: the credential is never rotated or
   * revoked, no second identity is created, and the barcode message is byte-identical, so an
   * already-installed pass and the front-desk scanner keep resolving exactly as before. When
   * the caller has no raw credential in hand (the usual case — raw is returned once, at
   * issuance), it is recovered from the stale artifact itself, which embeds it in plaintext
   * in pass.json, and then re-validated through the same primitive check-in scanning uses so
   * a corrupt or mismatched artifact can never seed a rebuild.
   *
   * Any failure returns the existing artifact untouched. A signing outage or a bad asset must
   * degrade to "member keeps the older-looking pass", never to a broken or absent one.
   */
  private async refreshStaleAppleArtifact(
    artifact: WalletPassArtifact,
    credential: WalletCredential,
    rawCredential: string | null,
    studioId: string,
    userId: string,
  ): Promise<WalletPassArtifact> {
    try {
      let raw = rawCredential;
      if (!raw) {
        const recovered = await this.tryRecoverAppleBarcode(credential);
        if (!recovered) {
          this.logger.warn(
            JSON.stringify({
              event: 'wallet.apple.template_refresh',
              outcome: 'skipped_unrecoverable_credential',
              studioId,
              walletCredentialId: credential.id,
            }),
          );
          return artifact;
        }
        raw = recovered.slice(WALLET_CREDENTIAL_PREFIX.length);
      }

      const refreshed = await this.provisionApple(credential.id, raw, studioId, userId);
      this.logger.log(
        JSON.stringify({
          event: 'wallet.apple.template_refresh',
          outcome: 'regenerated',
          studioId,
          walletCredentialId: credential.id,
          fromTemplateVersion: artifact.templateVersion,
          toTemplateVersion: APPLE_PASS_TEMPLATE_VERSION,
        }),
      );
      return refreshed;
    } catch (e) {
      this.logger.warn(
        JSON.stringify({
          event: 'wallet.apple.template_refresh',
          outcome: 'failed_serving_existing_artifact',
          studioId,
          walletCredentialId: credential.id,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
      return artifact;
    }
  }

  private async provisionApple(
    walletCredentialId: string,
    rawCredential: string,
    studioId: string,
    userId: string,
  ): Promise<WalletPassArtifact> {
    const [branding, member] = await Promise.all([
      this.branding.resolve(studioId),
      this.loadMemberContext(studioId, userId),
    ]);
    const pkpassData = await this.appleProvider.buildPkpass({
      walletCredentialId,
      rawCredential,
      memberName: member.memberName,
      planName: member.planName,
      branding,
    });
    // Prisma's Bytes field wants a plain Uint8Array<ArrayBuffer>; Node's Buffer is typed
    // Uint8Array<ArrayBufferLike> (could be a SharedArrayBuffer), so newer @types/node
    // rejects it directly even though the runtime value is always fine here.
    const pkpassBytes = Uint8Array.from(pkpassData);
    // Upsert keyed on (walletCredentialId, platform) — a refresh replaces the row's bytes in
    // place rather than adding a second artifact for the same credential.
    const artifact = await this.prisma.walletPassArtifact.upsert({
      where: { walletCredentialId_platform: { walletCredentialId, platform: WalletPassPlatform.APPLE } },
      create: {
        walletCredentialId,
        platform: WalletPassPlatform.APPLE,
        pkpassData: pkpassBytes,
        templateVersion: APPLE_PASS_TEMPLATE_VERSION,
      },
      update: { pkpassData: pkpassBytes, templateVersion: APPLE_PASS_TEMPLATE_VERSION },
    });
    this.logger.log(
      JSON.stringify({ event: 'wallet.apple.pass_generated', studioId, walletCredentialId }),
    );
    return artifact;
  }

  private async provisionGoogle(
    walletCredentialId: string,
    rawCredential: string,
    studioId: string,
    userId: string,
  ): Promise<WalletPassArtifact> {
    const [branding, member] = await Promise.all([
      this.branding.resolve(studioId),
      this.loadMemberContext(studioId, userId),
    ]);
    const { objectId } = await this.googleProvider.ensureClassAndObject({
      studioId,
      walletCredentialId,
      rawCredential,
      memberName: member.memberName,
      planName: member.planName,
      branding,
    });
    return this.prisma.walletPassArtifact.upsert({
      where: { walletCredentialId_platform: { walletCredentialId, platform: WalletPassPlatform.GOOGLE } },
      create: { walletCredentialId, platform: WalletPassPlatform.GOOGLE, googleObjectId: objectId },
      update: { googleObjectId: objectId },
    });
  }

  private async tryProvisionApple(
    walletCredentialId: string,
    rawCredential: string,
    studioId: string,
    userId: string,
  ): Promise<void> {
    const existing = await this.findArtifact(walletCredentialId, WalletPassPlatform.APPLE);
    if (!this.appleProvider.isConfigured()) return;
    // Raw is in hand here, so a stale artifact can be refreshed on the spot — merely opening
    // Mi Pase brings the member's pass up to the current presentation.
    if (existing && !isStaleAppleArtifact(existing)) return;
    try {
      await this.provisionApple(walletCredentialId, rawCredential, studioId, userId);
    } catch (e) {
      this.logger.warn(
        JSON.stringify({
          event: 'wallet.apple.pass_delivered',
          outcome: 'background_provision_failed',
          studioId,
          walletCredentialId,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }

  private async tryProvisionGoogle(
    walletCredentialId: string,
    rawCredential: string,
    studioId: string,
    userId: string,
  ): Promise<void> {
    const existing = await this.findArtifact(walletCredentialId, WalletPassPlatform.GOOGLE);
    if (existing || !this.googleProvider.isConfigured()) return;
    try {
      await this.provisionGoogle(walletCredentialId, rawCredential, studioId, userId);
    } catch (e) {
      this.logger.warn(
        JSON.stringify({
          event: 'wallet.google.object_created',
          outcome: 'background_provision_failed',
          studioId,
          walletCredentialId,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }
}
