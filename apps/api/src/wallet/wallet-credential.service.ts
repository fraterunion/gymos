import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, WalletCredential } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { acquireWalletCredentialAdvisoryLock } from './wallet-credential-advisory-lock';
import {
  WALLET_CREDENTIAL_MIN_RAW_LENGTH,
  WALLET_CREDENTIAL_PREFIX,
  generateRawWalletCredential,
  hashWalletCredential,
  isWalletCredentialBarcode,
} from './wallet-credential.constants';

const UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

export type IssueWalletCredentialResult = {
  credential: WalletCredential;
  /**
   * Only present when a NEW credential was created. The raw value is never persisted and
   * cannot be reconstructed, so a repeat issue() call for a member who already has an
   * active credential returns the existing row with rawCredential: null — callers that
   * need the raw value again (e.g. to generate a pass for a second platform/device) must
   * have cached it from the original issuance, or call reissue().
   */
  rawCredential: string | null;
  created: boolean;
};

export type WalletCredentialResolution =
  | { status: 'invalid' }
  | { status: 'revoked'; credential: WalletCredential }
  | { status: 'active'; credential: WalletCredential };

@Injectable()
export class WalletCredentialService {
  private readonly logger = new Logger(WalletCredentialService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get-or-create: at most one ACTIVE credential per (studioId, userId), enforced by a
   * partial unique index (wallet_credentials_one_active_per_member). Idempotent at the
   * credential-ROW level; never idempotent at the raw-VALUE level, by design — see
   * IssueWalletCredentialResult.rawCredential.
   */
  async issue(studioId: string, userId: string): Promise<IssueWalletCredentialResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await acquireWalletCredentialAdvisoryLock(tx, studioId, userId);

        const existing = await tx.walletCredential.findFirst({
          where: { studioId, userId, revokedAt: null },
        });
        if (existing) {
          return { credential: existing, rawCredential: null, created: false };
        }

        const rawCredential = generateRawWalletCredential();
        const credentialHash = hashWalletCredential(rawCredential);
        const credential = await tx.walletCredential.create({
          data: { studioId, userId, credentialHash },
        });
        this.logger.log(
          JSON.stringify({ event: 'wallet.credential.issued', studioId, walletCredentialId: credential.id }),
        );
        return { credential, rawCredential, created: true };
      });
    } catch (e) {
      // Backstop only: the advisory lock should make this unreachable under normal
      // operation. If the partial unique index still fires, return the winning row
      // rather than surface a raw constraint-violation error to the caller.
      if (isUniqueConstraintViolation(e)) {
        const existing = await this.prisma.walletCredential.findFirst({
          where: { studioId, userId, revokedAt: null },
        });
        if (existing) {
          return { credential: existing, rawCredential: null, created: false };
        }
      }
      throw e;
    }
  }

  /**
   * Revoke the active credential and issue a fresh one in the same locked transaction —
   * "lost phone" / "compromised pass" / "I need my raw value again and don't have it
   * cached." All prior physical/Wallet copies stop resolving the instant this commits.
   */
  async reissue(studioId: string, userId: string): Promise<{ credential: WalletCredential; rawCredential: string }> {
    return this.prisma.$transaction(async (tx) => {
      await acquireWalletCredentialAdvisoryLock(tx, studioId, userId);

      await tx.walletCredential.updateMany({
        where: { studioId, userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      const rawCredential = generateRawWalletCredential();
      const credentialHash = hashWalletCredential(rawCredential);
      const credential = await tx.walletCredential.create({
        data: { studioId, userId, credentialHash },
      });
      this.logger.log(
        JSON.stringify({ event: 'wallet.credential.reissued', studioId, walletCredentialId: credential.id }),
      );
      return { credential, rawCredential };
    });
  }

  async revoke(studioId: string, userId: string): Promise<void> {
    const result = await this.prisma.walletCredential.updateMany({
      where: { studioId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count > 0) {
      this.logger.log(JSON.stringify({ event: 'wallet.credential.revoked', studioId }));
    }
  }

  async revokeById(credentialId: string): Promise<void> {
    const result = await this.prisma.walletCredential.updateMany({
      where: { id: credentialId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count > 0) {
      this.logger.log(JSON.stringify({ event: 'wallet.credential.revoked', walletCredentialId: credentialId }));
    }
  }

  /**
   * barcode -> format check -> strip prefix -> SHA256 -> hash lookup. Never logs the raw
   * value or the barcode; callers must log only credential.id after a successful resolve.
   */
  async resolve(barcodeValue: string): Promise<WalletCredentialResolution> {
    if (!isWalletCredentialBarcode(barcodeValue)) {
      return { status: 'invalid' };
    }
    const raw = barcodeValue.slice(WALLET_CREDENTIAL_PREFIX.length);
    if (raw.length < WALLET_CREDENTIAL_MIN_RAW_LENGTH) {
      return { status: 'invalid' };
    }

    const credentialHash = hashWalletCredential(raw);
    const credential = await this.prisma.walletCredential.findUnique({ where: { credentialHash } });
    if (!credential) {
      return { status: 'invalid' };
    }
    return credential.revokedAt ? { status: 'revoked', credential } : { status: 'active', credential };
  }

  async touchLastUsed(credentialId: string): Promise<void> {
    await this.prisma.walletCredential.update({
      where: { id: credentialId },
      data: { lastUsedAt: new Date() },
    });
  }
}

function isUniqueConstraintViolation(e: unknown): e is Prisma.PrismaClientKnownRequestError {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    (e as { code?: unknown }).code === UNIQUE_CONSTRAINT_VIOLATION
  );
}
