import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PlatformRole, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import type { LoginDto } from './dto/login.dto';
import type { RefreshTokenDto } from './dto/refresh-token.dto';
import type { RegisterDto } from './dto/register.dto';

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthBundle> {
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
        return created;
      });
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
