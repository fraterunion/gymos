import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PlatformRole, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionalEmailService } from '../email/transactional-email.service';
import { AuditService } from '../sales/audit.service';
import { WaiverService } from '../waiver/waiver.service';
import type { ChangePasswordDto } from './dto/change-password.dto';
import type { ForgotPasswordDto } from './dto/forgot-password.dto';
import type { LoginDto } from './dto/login.dto';
import type { RefreshTokenDto } from './dto/refresh-token.dto';
import type { RegisterDto } from './dto/register.dto';
import type { ResetPasswordDto } from './dto/reset-password.dto';
import {
  PASSWORD_SAME_AS_CURRENT_MESSAGE,
  validatePassword,
} from './password-policy';

/** Reset links are short-lived by design: long enough to find the mail, short enough that
 *  a leaked inbox is not an indefinite account takeover. */
export const PASSWORD_RESET_TTL_MINUTES = 30;
/** Per-account request cap (the route also carries an IP-based throttle). */
export const MAX_RESET_REQUESTS_PER_WINDOW = 5;
export const RESET_REQUEST_WINDOW_MS = 15 * 60_000;

/** One message for every invalid-token case — expired, consumed, superseded or unknown. */
export const PASSWORD_RESET_TOKEN_INVALID_MESSAGE =
  'El enlace de restablecimiento no es válido o ya expiró. Solicita uno nuevo.';
export const CURRENT_PASSWORD_INVALID_MESSAGE = 'La contraseña actual es incorrecta.';
export const PASSWORD_RESET_REQUESTED_MESSAGE =
  'Si existe una cuenta asociada a este correo, recibirás instrucciones para restablecer tu contraseña.';
/** Shown only when the studio/platform has recovery switched off entirely. */
export const PASSWORD_RECOVERY_DISABLED_MESSAGE =
  'El restablecimiento de contraseña no está disponible. Contacta a tu estudio para recuperar tu acceso.';

export type SafeUser = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  platformRole: PlatformRole | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AuthBundle = {
  accessToken: string;
  refreshToken: string;
  user: SafeUser;
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly waiverService: WaiverService,
    private readonly email: TransactionalEmailService,
    private readonly audit: AuditService,
  ) {}

  async register(
    dto: RegisterDto,
    clientMeta?: { ipAddress?: string; userAgent?: string },
  ): Promise<AuthBundle> {
    // Same shared policy as reset and change — registration must never drift from them.
    const policy = validatePassword(dto.password);
    if (!policy.valid) {
      throw new BadRequestException(policy.message);
    }
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('Email already registered');
    }
    const passwordHash = await this.hashPassword(dto.password);

    if (dto.studioSlug) {
      const studio = await this.prisma.studio.findFirst({
        where: { slug: dto.studioSlug, deletedAt: null },
        select: { id: true },
      });
      if (!studio) {
        throw new BadRequestException('Studio not found');
      }

      // Validate the waiver BEFORE the transaction. If valid, we get back the specific
      // waiverDocumentId that was active at validation time. We pass this exact ID into
      // the transaction so createSelfAcceptanceInTx does not need to re-query isActive,
      // eliminating the TOCTOU window between validation and acceptance creation.
      const waiver = await this.waiverService.validateRegistrationWaiver({
        studioId: studio.id,
        waiverDocumentId: dto.waiverDocumentId,
        waiverAccepted: dto.waiverAccepted,
      });

      // Atomic registration: user + membership + waiver acceptance all commit together
      // or all roll back. An email can never be consumed without a complete registration.
      const user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email: dto.email,
            firstName: dto.firstName,
            lastName: dto.lastName,
            passwordHash,
          },
        });
        await tx.studioMembership.upsert({
          where: { userId_studioId: { userId: created.id, studioId: studio.id } },
          create: { userId: created.id, studioId: studio.id, role: Role.MEMBER },
          update: { role: Role.MEMBER, deletedAt: null },
        });
        if (waiver) {
          await this.waiverService.createSelfAcceptanceInTx(tx, {
            studioId: studio.id,
            userId: created.id,
            waiverDocumentId: waiver.waiverDocumentId,
            ipAddress: clientMeta?.ipAddress,
            userAgent: clientMeta?.userAgent,
          });
        }
        return created;
      });

      this.logger.log(
        JSON.stringify({
          event: 'registration_complete',
          userId: user.id,
          studioId: studio.id,
          waiverAccepted: Boolean(waiver),
          waiverDocumentId: waiver?.waiverDocumentId ?? null,
        }),
      );

      return this.issueAuthBundle(user.id, user.email);
    }

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        firstName: dto.firstName,
        lastName: dto.lastName,
        passwordHash,
      },
    });
    return this.issueAuthBundle(user.id, user.email);
  }

  async login(dto: LoginDto): Promise<AuthBundle> {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user || user.deletedAt) {
      throw new UnauthorizedException('Invalid credentials');
    }
    if (!user.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return this.issueAuthBundle(user.id, user.email);
  }

  /**
   * Step 1 of recovery. ALWAYS resolves the same way to the caller: the controller returns
   * one generic message whether or not the address belongs to an account, so this endpoint
   * can never be used to enumerate users. Everything below happens silently.
   */
  async requestPasswordReset(
    dto: ForgotPasswordDto,
    clientMeta?: { ipAddress?: string; userAgent?: string },
  ): Promise<void> {
    this.assertPasswordRecoveryEnabled();
    const email = dto.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, firstName: true, email: true, deletedAt: true, passwordHash: true },
    });

    if (!user || user.deletedAt) {
      // No account (or a soft-deleted one): do no work, write no audit row, and log
      // nothing that identifies the address — support tooling must not become an
      // enumeration oracle either.
      this.logger.log(
        JSON.stringify({ event: 'password_reset_requested', outcome: 'no_matching_account' }),
      );
      return;
    }

    // Per-account throttle on top of the IP throttle on the route: a distributed attempt
    // still cannot flood one person's inbox. Silent — the caller sees the same response.
    const since = new Date(Date.now() - RESET_REQUEST_WINDOW_MS);
    const recentCount = await this.prisma.passwordResetToken.count({
      where: { userId: user.id, createdAt: { gte: since } },
    });
    if (recentCount >= MAX_RESET_REQUESTS_PER_WINDOW) {
      this.logger.warn(
        JSON.stringify({
          event: 'password_reset_requested',
          outcome: 'rate_limited_per_account',
          userId: user.id,
        }),
      );
      return;
    }

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = this.hashResetToken(rawToken);
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60_000);

    await this.prisma.$transaction(async (tx) => {
      // Requesting a new link renders every older one unusable.
      await tx.passwordResetToken.updateMany({
        where: { userId: user.id, consumedAt: null, invalidatedAt: null },
        data: { invalidatedAt: new Date() },
      });
      await tx.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash,
          expiresAt,
          requestIp: clientMeta?.ipAddress ?? null,
          requestUserAgent: clientMeta?.userAgent ?? null,
        },
      });
    });

    const { branding } = await this.email.sendPasswordReset({
      userId: user.id,
      email: user.email,
      firstName: user.firstName,
      token: rawToken,
      expiresInMinutes: PASSWORD_RESET_TTL_MINUTES,
      hintedStudioId: await this.resolveHintedStudioId(dto.studioSlug),
    });

    await this.writeSecurityAudit(branding.studioId, user.id, 'PASSWORD_RESET_REQUESTED');
  }

  /**
   * Step 2 of recovery. The password update, token consumption, invalidation of sibling
   * tokens and session revocation all commit together or not at all.
   */
  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    this.assertPasswordRecoveryEnabled();
    const policy = validatePassword(dto.newPassword);
    if (!policy.valid) {
      throw new BadRequestException(policy.message);
    }

    const tokenHash = this.hashResetToken(dto.token);
    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        expiresAt: true,
        consumedAt: true,
        invalidatedAt: true,
        user: { select: { id: true, deletedAt: true } },
      },
    });

    // One message for every failure mode: an attacker learns nothing about whether a token
    // existed, was already used, or merely expired.
    if (
      !record ||
      record.consumedAt !== null ||
      record.invalidatedAt !== null ||
      record.expiresAt.getTime() <= Date.now() ||
      record.user.deletedAt !== null
    ) {
      throw new BadRequestException(PASSWORD_RESET_TOKEN_INVALID_MESSAGE);
    }

    const passwordHash = await this.hashPassword(dto.newPassword);
    const now = new Date();

    const consumed = await this.prisma.$transaction(async (tx) => {
      // Compare-and-set: two concurrent submissions of the same link cannot both win.
      const claim = await tx.passwordResetToken.updateMany({
        where: { id: record.id, consumedAt: null, invalidatedAt: null },
        data: { consumedAt: now },
      });
      if (claim.count === 0) {
        return false;
      }
      await tx.user.update({ where: { id: record.userId }, data: { passwordHash } });
      await tx.passwordResetToken.updateMany({
        where: { userId: record.userId, consumedAt: null, invalidatedAt: null },
        data: { invalidatedAt: now },
      });
      await tx.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: now },
      });
      return true;
    });

    if (!consumed) {
      throw new BadRequestException(PASSWORD_RESET_TOKEN_INVALID_MESSAGE);
    }

    const branding = await this.email.resolveBrandingForUser(record.userId);
    await this.writeSecurityAudit(branding.studioId, record.userId, 'PASSWORD_RESET_COMPLETED');
    this.logger.log(
      JSON.stringify({ event: 'password_reset_completed', userId: record.userId }),
    );
  }

  /**
   * Authenticated change. Returns a fresh session: every refresh token is revoked (so other
   * devices are signed out) and the caller immediately receives new credentials, which is
   * why the current device stays usable without ever trusting a client-supplied token.
   */
  async changePassword(userId: string, dto: ChangePasswordDto): Promise<AuthBundle> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, passwordHash: true, deletedAt: true },
    });
    if (!user || user.deletedAt || !user.passwordHash) {
      throw new UnauthorizedException();
    }

    const currentOk = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!currentOk) {
      throw new UnauthorizedException(CURRENT_PASSWORD_INVALID_MESSAGE);
    }

    const policy = validatePassword(dto.newPassword);
    if (!policy.valid) {
      throw new BadRequestException(policy.message);
    }

    const sameAsCurrent = await bcrypt.compare(dto.newPassword, user.passwordHash);
    if (sameAsCurrent) {
      throw new BadRequestException(PASSWORD_SAME_AS_CURRENT_MESSAGE);
    }

    const passwordHash = await this.hashPassword(dto.newPassword);
    const now = new Date();
    const familyId = randomUUID();
    const replacement = this.createOpaqueRefresh();

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      // Revoke everything, then mint this device's replacement inside the same transaction:
      // no window exists in which an old session survives a successful change.
      await tx.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.passwordResetToken.updateMany({
        where: { userId: user.id, consumedAt: null, invalidatedAt: null },
        data: { invalidatedAt: now },
      });
      await tx.refreshToken.create({
        data: {
          userId: user.id,
          familyId,
          tokenHash: replacement.tokenHash,
          expiresAt: this.refreshExpiryDate(),
        },
      });
    });

    const branding = await this.email.resolveBrandingForUser(user.id);
    await this.writeSecurityAudit(branding.studioId, user.id, 'PASSWORD_CHANGED');
    this.logger.log(JSON.stringify({ event: 'password_changed', userId: user.id }));

    const safeUser = await this.getSafeUser(user.id);
    const accessToken = await this.signAccessToken(user.id, user.email, safeUser.platformRole);
    return { accessToken, refreshToken: replacement.raw, user: safeUser };
  }

  /**
   * Email-dependent recovery is a per-environment capability. The refusal is GLOBAL — it
   * cannot vary by address — so it stays enumeration-safe, and `change-password`
   * (which needs no email) is deliberately NOT gated by it.
   */
  isPasswordRecoveryEnabled(): boolean {
    return this.config.get<string>('PASSWORD_RECOVERY_ENABLED', 'false') === 'true';
  }

  private assertPasswordRecoveryEnabled(): void {
    if (!this.isPasswordRecoveryEnabled()) {
      throw new ServiceUnavailableException(PASSWORD_RECOVERY_DISABLED_MESSAGE);
    }
  }

  /** Reset tokens are stored hashed, exactly like refresh tokens. */
  private hashResetToken(plain: string): string {
    return createHash('sha256').update(plain, 'utf8').digest('hex');
  }

  private async resolveHintedStudioId(studioSlug?: string): Promise<string | null> {
    if (!studioSlug) return null;
    const studio = await this.prisma.studio.findFirst({
      where: { slug: studioSlug.trim(), deletedAt: null },
      select: { id: true },
    });
    return studio?.id ?? null;
  }

  /**
   * AuditLog is studio-scoped (studioId is NOT NULL), but a password belongs to the
   * platform-level User. We therefore record the event against the studio that brands the
   * account and skip the row for a user with no studio at all — the structured log above
   * is the record in that case. Metadata never contains credentials, hashes or tokens.
   */
  private async writeSecurityAudit(
    studioId: string | null,
    userId: string,
    action: 'PASSWORD_RESET_REQUESTED' | 'PASSWORD_RESET_COMPLETED' | 'PASSWORD_CHANGED',
  ): Promise<void> {
    if (!studioId) return;
    try {
      await this.audit.log({
        studioId,
        actorUserId: userId,
        action,
        targetUserId: userId,
        entityType: 'User',
        entityId: userId,
        metadata: { origin: 'GYMOS', surface: 'AUTH' },
      });
    } catch (err) {
      // An audit failure must never block a user from regaining access to their account.
      this.logger.error(
        JSON.stringify({ event: 'security_audit_write_failed', action, userId }),
        err instanceof Error ? err.stack : undefined,
      );
    }
  }

  async refresh(dto: RefreshTokenDto): Promise<AuthBundle> {
    const hash = this.hashRefreshToken(dto.refreshToken);
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hash },
      include: { user: true },
    });

    if (!record) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (record.user.deletedAt) {
      await this.revokeRefreshTokenFamily(record.familyId, record.userId);
      throw new UnauthorizedException();
    }

    if (record.revokedAt) {
      await this.revokeRefreshTokenFamily(record.familyId, record.userId);
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    if (record.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    const newRefresh = this.createOpaqueRefresh();

    const rotated = await this.prisma.$transaction(async (tx) => {
      const cas = await tx.refreshToken.updateMany({
        where: { id: record.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (cas.count === 0) {
        return false;
      }
      await tx.refreshToken.create({
        data: {
          userId: record.userId,
          familyId: record.familyId,
          tokenHash: newRefresh.tokenHash,
          expiresAt: this.refreshExpiryDate(),
        },
      });
      return true;
    });

    if (!rotated) {
      await this.revokeRefreshTokenFamily(record.familyId, record.userId);
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    const user = await this.getSafeUser(record.userId);
    const accessToken = await this.signAccessToken(record.userId, record.user.email, user.platformRole);
    return { accessToken, refreshToken: newRefresh.raw, user };
  }

  async logout(dto: RefreshTokenDto): Promise<void> {
    const hash = this.hashRefreshToken(dto.refreshToken);
    const record = await this.prisma.refreshToken.findUnique({ where: { tokenHash: hash } });
    if (!record || record.revokedAt) {
      return;
    }
    await this.prisma.refreshToken.update({
      where: { id: record.id },
      data: { revokedAt: new Date() },
    });
  }

  async logoutAll(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async getMe(userId: string): Promise<SafeUser> {
    return this.getSafeUser(userId);
  }

  async hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, this.getBcryptRounds());
  }

  private async issueAuthBundle(userId: string, email: string): Promise<AuthBundle> {
    const familyId = randomUUID();
    const { raw, tokenHash } = this.createOpaqueRefresh();
    await this.prisma.refreshToken.create({
      data: {
        userId,
        familyId,
        tokenHash,
        expiresAt: this.refreshExpiryDate(),
      },
    });
    const user = await this.getSafeUser(userId);
    const accessToken = await this.signAccessToken(userId, email, user.platformRole);
    return { accessToken, refreshToken: raw, user };
  }

  private async revokeRefreshTokenFamily(familyId: string, userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, userId },
      data: { revokedAt: new Date() },
    });
  }

  private createOpaqueRefresh(): { raw: string; tokenHash: string } {
    const raw = randomBytes(64).toString('hex');
    return { raw, tokenHash: this.hashRefreshToken(raw) };
  }

  private hashRefreshToken(plain: string): string {
    return createHash('sha256').update(plain, 'utf8').digest('hex');
  }

  private getBcryptRounds(): number {
    const raw = this.config.get<string>('BCRYPT_ROUNDS', '12');
    const n = Number.parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 1 || n > 31) {
      return 12;
    }
    return n;
  }

  private refreshExpiryDate(): Date {
    const raw = this.config.get<string>('JWT_REFRESH_TTL_DAYS', '30');
    const days = Number(raw);
    const safeDays = Number.isFinite(days) && days > 0 ? days : 30;
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + safeDays);
    return d;
  }

  private async signAccessToken(sub: string, email: string, platformRole: PlatformRole | null): Promise<string> {
    return this.jwtService.signAsync({ sub, email, platformRole });
  }

  private async getSafeUser(userId: string): Promise<SafeUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        platformRole: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
      },
    });
    if (!user || user.deletedAt) {
      throw new UnauthorizedException();
    }
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      platformRole: user.platformRole,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }
}
