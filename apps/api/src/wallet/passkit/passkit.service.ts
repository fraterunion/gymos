import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { Prisma, WalletPassEventType, WalletPassMode, WalletPassPlatform, type WalletPassArtifact } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AppleWalletProvider } from '../apple/apple-wallet-provider.service';
import { parseApplePassAuthorization, verifyPassAuthenticationToken } from '../apple/passkit-token';
import { WalletPassEventsService } from './wallet-pass-events.service';

/** Bounded input. Apple's identifiers are opaque; these bounds are generous but finite. */
const DEVICE_LIBRARY_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const SERIAL_NUMBER_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const PASS_TYPE_ID_MAX_LENGTH = 128;
/** APNs device tokens are hex; Apple says not to assume a fixed length. */
const PUSH_TOKEN_PATTERN = /^[0-9a-fA-F]{16,256}$/;
const UPDATED_SINCE_PATTERN = /^\d{1,15}$/;
/** Real members hold a pass on a handful of devices (iPhone, Watch, iPad). */
export const MAX_REGISTRATIONS_PER_PASS = 10;
const MAX_SERIALS_PER_RESPONSE = 100;
/**
 * The cursor (lastUpdated) handed to a device is never newer than this long before the
 * server's clock. A pass whose content timestamp was taken just before a poll but whose write
 * committed just after it therefore still sorts after the device's cursor and is delivered on
 * the next poll. Cost: a pass changed within this window may be downloaded twice.
 */
export const CURSOR_SAFETY_LAG_MS = 2_000;
const MAX_DEVICE_LOG_MESSAGES = 20;
const MAX_DEVICE_LOG_MESSAGE_LENGTH = 512;

const UNAUTHORIZED = 'Unauthorized';

export type PasskitPassRef = { passTypeIdentifier: string; serialNumber: string };
export type PasskitDeviceRef = { deviceLibraryIdentifier: string; passTypeIdentifier: string };

type AuthenticatedPass = WalletPassArtifact & { walletCredential: { studioId: string } };

/** Short, non-reversible correlation id for a device (the raw identifier is never logged). */
function deviceRef(deviceLibraryIdentifier: string): string {
  return createHash('sha256').update(deviceLibraryIdentifier).digest('hex').slice(0, 12);
}

/**
 * HTTP conditional GET (RFC 9110): the stored pass is "not modified" when the device's
 * If-Modified-Since is at or after the pass's Last-Modified, compared at the one-second
 * precision of HTTP dates. Unparseable or absent headers mean a full 200 response.
 */
export function isPassNotModified(lastModifiedAt: Date, ifModifiedSince: string | string[] | undefined): boolean {
  if (typeof ifModifiedSince !== 'string' || ifModifiedSince.length > 64) return false;
  const since = Date.parse(ifModifiedSince);
  if (Number.isNaN(since)) return false;
  return Math.floor(lastModifiedAt.getTime() / 1000) <= Math.floor(since / 1000);
}

export type LatestPassResult =
  | { notModified: true; lastModifiedAt: Date; passVersion: number }
  | { notModified: false; pkpass: Buffer; lastModifiedAt: Date; passVersion: number };

/** Keeps printable characters only (no control characters reach the log line). */
function stripControlCharacters(message: string): string {
  let out = '';
  for (const ch of message) {
    const code = ch.codePointAt(0)!;
    out += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  return out;
}

function sanitizeDeviceLogMessage(message: string): string {
  return stripControlCharacters(message.slice(0, MAX_DEVICE_LOG_MESSAGE_LENGTH)).replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]');
}

/**
 * Apple PassKit web service (Smart Wallet 2.0, Stage 1A). Contract:
 * https://developer.apple.com/documentation/walletpasses/adding-a-web-service-to-update-passes
 *
 * - Pass-scoped calls (register, unregister, latest pass) authenticate with the pass's own
 *   `ApplePass <authenticationToken>`, verified in constant time against the stored hash. Every
 *   failure — unknown pass type, malformed or unknown serial, STATIC pass, wrong or missing token
 *   — is the same 401, so the endpoint is not an oracle for which serials exist.
 * - The device-scoped serials query is unauthenticated by Apple's design; it only ever returns
 *   serials this device registered through an authenticated call.
 * - Tenant isolation: a registration's studioId is copied from the pass's own credential; no
 *   request field selects a studio.
 * - Nothing here decides access, and nothing here builds or signs passes: the latest-pass route
 *   serves the stored DYNAMIC artifact bytes.
 */
@Injectable()
export class PasskitService {
  private readonly logger = new Logger(PasskitService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appleProvider: AppleWalletProvider,
    private readonly events: WalletPassEventsService,
  ) {}

  async register(
    deviceLibraryIdentifier: string,
    pass: PasskitPassRef,
    authorization: string | string[] | undefined,
    body: unknown,
  ): Promise<'created' | 'existing'> {
    const artifact = await this.authenticate(pass, authorization);
    if (!DEVICE_LIBRARY_ID_PATTERN.test(deviceLibraryIdentifier)) {
      throw new BadRequestException('Invalid device library identifier');
    }
    const pushToken = (body as { pushToken?: unknown } | null)?.pushToken;
    if (typeof pushToken !== 'string' || !PUSH_TOKEN_PATTERN.test(pushToken)) {
      throw new BadRequestException('Invalid push token');
    }

    const key = {
      deviceLibraryIdentifier_passTypeIdentifier_serialNumber: {
        deviceLibraryIdentifier,
        passTypeIdentifier: pass.passTypeIdentifier,
        serialNumber: pass.serialNumber,
      },
    };
    const existing = await this.prisma.walletPassRegistration.findUnique({ where: key });
    if (existing) {
      const pushTokenChanged = existing.pushToken !== pushToken;
      if (pushTokenChanged) {
        await this.prisma.walletPassRegistration.update({ where: { id: existing.id }, data: { pushToken } });
      }
      this.logRegistration('existing', artifact, deviceLibraryIdentifier);
      await this.recordRegistration(artifact, deviceLibraryIdentifier, 'existing', pushTokenChanged);
      return 'existing';
    }

    const registered = await this.prisma.walletPassRegistration.count({ where: { walletPassArtifactId: artifact.id } });
    if (registered >= MAX_REGISTRATIONS_PER_PASS) {
      this.logger.warn(
        JSON.stringify({
          event: 'wallet.passkit.registration_limit',
          studioId: artifact.walletCredential.studioId,
          walletCredentialId: artifact.walletCredentialId,
          device: deviceRef(deviceLibraryIdentifier),
        }),
      );
      throw new UnauthorizedException(UNAUTHORIZED);
    }

    try {
      await this.prisma.walletPassRegistration.create({
        data: {
          studioId: artifact.walletCredential.studioId,
          walletPassArtifactId: artifact.id,
          deviceLibraryIdentifier,
          passTypeIdentifier: pass.passTypeIdentifier,
          serialNumber: pass.serialNumber,
          pushToken,
        },
      });
    } catch (e) {
      // A concurrent identical registration won the insert: same outcome, already registered.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        await this.prisma.walletPassRegistration.updateMany({ where: key.deviceLibraryIdentifier_passTypeIdentifier_serialNumber, data: { pushToken } });
        this.logRegistration('existing', artifact, deviceLibraryIdentifier);
        await this.recordRegistration(artifact, deviceLibraryIdentifier, 'existing', false);
        return 'existing';
      }
      throw e;
    }
    this.logRegistration('created', artifact, deviceLibraryIdentifier);
    await this.recordRegistration(artifact, deviceLibraryIdentifier, 'created', false);
    return 'created';
  }

  async unregister(
    deviceLibraryIdentifier: string,
    pass: PasskitPassRef,
    authorization: string | string[] | undefined,
  ): Promise<void> {
    const artifact = await this.authenticate(pass, authorization);
    if (!DEVICE_LIBRARY_ID_PATTERN.test(deviceLibraryIdentifier)) {
      throw new BadRequestException('Invalid device library identifier');
    }
    const where = {
      deviceLibraryIdentifier,
      passTypeIdentifier: pass.passTypeIdentifier,
      serialNumber: pass.serialNumber,
      walletPassArtifactId: artifact.id,
    };
    const existing = await this.prisma.walletPassRegistration.findFirst({ where, select: { createdAt: true } });
    const { count } = await this.prisma.walletPassRegistration.deleteMany({ where });
    const registrationAgeMs = existing ? Date.now() - existing.createdAt.getTime() : null;
    this.logger.log(
      JSON.stringify({
        event: 'wallet.passkit.unregistered',
        studioId: artifact.walletCredential.studioId,
        walletCredentialId: artifact.walletCredentialId,
        device: deviceRef(deviceLibraryIdentifier),
        removed: count,
        registrationAgeMs,
      }),
    );
    await this.events.record({
      studioId: artifact.walletCredential.studioId,
      walletPassArtifactId: artifact.id,
      walletCredentialId: artifact.walletCredentialId,
      type: WalletPassEventType.UNREGISTERED,
      deviceLibraryIdentifier,
      passVersion: artifact.passVersion,
      httpStatus: 200,
      detail: { removed: count, registrationAgeMs },
    });
  }

  /**
   * Serial numbers of this device's registered DYNAMIC passes whose content changed after the
   * device's cursor (all of them when it sends none). Null means "204 No Content".
   */
  async listUpdatedSerials(
    device: PasskitDeviceRef,
    passesUpdatedSince: unknown,
  ): Promise<{ serialNumbers: string[]; lastUpdated: string } | null> {
    if (
      !DEVICE_LIBRARY_ID_PATTERN.test(device.deviceLibraryIdentifier) ||
      device.passTypeIdentifier !== this.configuredPassTypeIdentifier()
    ) {
      return null;
    }
    const since =
      typeof passesUpdatedSince === 'string' && UPDATED_SINCE_PATTERN.test(passesUpdatedSince)
        ? Number(passesUpdatedSince)
        : null;

    const rows = await this.prisma.walletPassRegistration.findMany({
      where: {
        deviceLibraryIdentifier: device.deviceLibraryIdentifier,
        passTypeIdentifier: device.passTypeIdentifier,
        artifact: {
          passMode: WalletPassMode.DYNAMIC,
          ...(since !== null ? { lastModifiedAt: { gt: new Date(since) } } : {}),
        },
      },
      select: {
        serialNumber: true,
        studioId: true,
        artifact: { select: { id: true, walletCredentialId: true, passVersion: true, lastModifiedAt: true } },
      },
      orderBy: { serialNumber: 'asc' },
      take: MAX_SERIALS_PER_RESPONSE,
    });
    if (rows.length === 0) return null;

    const newest = Math.max(...rows.map((r) => r.artifact.lastModifiedAt?.getTime() ?? 0));
    const lastUpdated = Math.min(newest, Date.now() - CURSOR_SAFETY_LAG_MS);
    // Per-device delivery evidence: this device asked which passes changed and was told about
    // these. (APNs accepting a push does not prove a device acted on it; this does.)
    for (const r of rows) {
      await this.events.record({
        studioId: r.studioId,
        walletPassArtifactId: r.artifact.id,
        walletCredentialId: r.artifact.walletCredentialId,
        type: WalletPassEventType.SERIALS_LISTED,
        deviceLibraryIdentifier: device.deviceLibraryIdentifier,
        passVersion: r.artifact.passVersion,
        httpStatus: 200,
        detail: { listed: rows.length, sinceTag: since !== null },
      });
    }
    return { serialNumbers: rows.map((r) => r.serialNumber), lastUpdated: String(Math.max(lastUpdated, since ?? 0)) };
  }

  /**
   * The latest pass, or a 304 when the device already holds it. The decision is made here, so
   * the log and the history record exactly what the device received: `pass_served` only for a
   * 200 carrying the .pkpass body, `pass_not_modified` for a 304 with no body.
   */
  async getLatestPass(
    pass: PasskitPassRef,
    authorization: string | string[] | undefined,
    ifModifiedSince?: string | string[],
  ): Promise<LatestPassResult> {
    const artifact = await this.authenticate(pass, authorization);
    const lastModifiedAt = artifact.lastModifiedAt ?? artifact.updatedAt;
    const base = {
      studioId: artifact.walletCredential.studioId,
      walletPassArtifactId: artifact.id,
      walletCredentialId: artifact.walletCredentialId,
      passVersion: artifact.passVersion,
    };
    if (isPassNotModified(lastModifiedAt, ifModifiedSince)) {
      this.logger.log(JSON.stringify({ event: 'wallet.passkit.pass_not_modified', studioId: base.studioId, walletCredentialId: base.walletCredentialId, passVersion: base.passVersion }));
      await this.events.record({ ...base, type: WalletPassEventType.PASS_NOT_MODIFIED, httpStatus: 304 });
      return { notModified: true, lastModifiedAt, passVersion: artifact.passVersion };
    }
    const pkpass = Buffer.from(artifact.pkpassData!);
    this.logger.log(
      JSON.stringify({
        event: 'wallet.passkit.pass_served',
        studioId: base.studioId,
        walletCredentialId: base.walletCredentialId,
        passVersion: base.passVersion,
        bytes: pkpass.length,
      }),
    );
    await this.events.record({
      ...base,
      type: WalletPassEventType.PASS_RETRIEVED,
      httpStatus: 200,
      detail: { bytes: pkpass.length, ifModifiedSince: typeof ifModifiedSince === 'string' },
    });
    return { notModified: false, pkpass, lastModifiedAt, passVersion: artifact.passVersion };
  }

  /** Apple's diagnostic channel. Bounded, sanitized, never persisted. */
  recordDeviceLog(body: unknown): void {
    const logs = (body as { logs?: unknown } | null)?.logs;
    const messages = Array.isArray(logs)
      ? logs
          .filter((m): m is string => typeof m === 'string')
          .slice(0, MAX_DEVICE_LOG_MESSAGES)
          .map(sanitizeDeviceLogMessage)
      : [];
    this.logger.warn(
      JSON.stringify({
        event: 'wallet.passkit.device_log',
        received: Array.isArray(logs) ? logs.length : 0,
        messages,
      }),
    );
  }

  /** Resolves and authenticates one DYNAMIC pass, or throws the same 401 for every failure. */
  private async authenticate(
    pass: PasskitPassRef,
    authorization: string | string[] | undefined,
  ): Promise<AuthenticatedPass> {
    const token = parseApplePassAuthorization(authorization);
    const wellFormed =
      typeof pass.passTypeIdentifier === 'string' &&
      pass.passTypeIdentifier.length <= PASS_TYPE_ID_MAX_LENGTH &&
      pass.passTypeIdentifier === this.configuredPassTypeIdentifier() &&
      SERIAL_NUMBER_PATTERN.test(pass.serialNumber);

    const artifact =
      wellFormed && token
        ? await this.prisma.walletPassArtifact.findUnique({
            where: { walletCredentialId_platform: { walletCredentialId: pass.serialNumber, platform: WalletPassPlatform.APPLE } },
            include: { walletCredential: { select: { studioId: true } } },
          })
        : null;

    const ok =
      token !== null &&
      artifact !== null &&
      artifact.passMode === WalletPassMode.DYNAMIC &&
      artifact.pkpassData !== null &&
      verifyPassAuthenticationToken(token, artifact.authenticationTokenHash);
    if (!ok || artifact === null) {
      this.logger.warn(
        JSON.stringify({
          event: 'wallet.passkit.unauthorized',
          reason: !token ? 'missing_or_malformed_token' : !wellFormed ? 'unknown_pass' : 'not_authenticated',
        }),
      );
      throw new UnauthorizedException(UNAUTHORIZED);
    }
    return artifact;
  }

  private configuredPassTypeIdentifier(): string | null {
    return this.appleProvider.isConfigured() ? this.appleProvider.passTypeIdentifier() : null;
  }

  private recordRegistration(
    artifact: AuthenticatedPass,
    deviceLibraryIdentifier: string,
    outcome: 'created' | 'existing',
    pushTokenChanged: boolean,
  ): Promise<void> {
    return this.events.record({
      studioId: artifact.walletCredential.studioId,
      walletPassArtifactId: artifact.id,
      walletCredentialId: artifact.walletCredentialId,
      type: WalletPassEventType.REGISTERED,
      deviceLibraryIdentifier,
      passVersion: artifact.passVersion,
      httpStatus: outcome === 'created' ? 201 : 200,
      detail: { outcome, pushTokenChanged },
    });
  }

  private logRegistration(outcome: 'created' | 'existing', artifact: AuthenticatedPass, deviceLibraryIdentifier: string): void {
    this.logger.log(
      JSON.stringify({
        event: 'wallet.passkit.registered',
        outcome,
        studioId: artifact.walletCredential.studioId,
        walletCredentialId: artifact.walletCredentialId,
        device: deviceRef(deviceLibraryIdentifier),
      }),
    );
  }
}
