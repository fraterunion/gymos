import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { UpdateBookingSettingsDto } from './dto/update-booking-settings.dto';
import type { UpdateMobileConfigDto } from './dto/update-mobile-config.dto';
import type { UpdateStudioBrandingDto } from './dto/update-studio-branding.dto';
import type { UpdateStudioSettingsDto } from './dto/update-studio-settings.dto';

const studioSettingsSelect = {
  id: true,
  name: true,
  slug: true,
  timezone: true,
  supportEmail: true,
  supportPhone: true,
  websiteUrl: true,
  instagramHandle: true,
  address: true,
  privacyUrl: true,
  termsUrl: true,
  logoUrl: true,
  coverImageUrl: true,
  primaryColor: true,
  accentColor: true,
  brandLogoUrl: true,
  brandPrimaryColor: true,
  brandSecondaryColor: true,
  brandIconUrl: true,
  brandSplashUrl: true,
  allowWaitlist: true,
  autoConfirmWaitlist: true,
  cancellationWindowHours: true,
  lateCancelPenaltyEnabled: true,
  checkInWindowMinutes: true,
  appDisplayName: true,
  appScheme: true,
  expoSlug: true,
  iosBundleId: true,
  androidPackageName: true,
  appName: true,
  appStoreUrl: true,
  playStoreUrl: true,
  updatedAt: true,
} satisfies Prisma.StudioSelect;

type StudioSettingsRow = Prisma.StudioGetPayload<{ select: typeof studioSettingsSelect }>;

@Injectable()
export class StudioSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async getSettings(studioId: string) {
    const studio = await this.loadStudio(studioId);
    return this.shapeResponse(studio);
  }

  async updateGeneral(studioId: string, dto: UpdateStudioSettingsDto) {
    const data: Prisma.StudioUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.timezone !== undefined) data.timezone = dto.timezone;
    if (dto.supportEmail !== undefined) data.supportEmail = dto.supportEmail;
    if (dto.supportPhone !== undefined) data.supportPhone = dto.supportPhone;
    if (dto.websiteUrl !== undefined) data.websiteUrl = dto.websiteUrl;
    if (dto.instagramHandle !== undefined) data.instagramHandle = dto.instagramHandle;
    if (dto.address !== undefined) data.address = dto.address;

    if (Object.keys(data).length === 0) {
      return this.shapeResponse(await this.loadStudio(studioId));
    }

    const studio = await this.safeUpdate(studioId, data);
    return this.shapeResponse(studio);
  }

  async updateBranding(studioId: string, dto: UpdateStudioBrandingDto) {
    const data: Prisma.StudioUpdateInput = {};
    if (dto.logoUrl !== undefined) data.logoUrl = dto.logoUrl;
    if (dto.coverImageUrl !== undefined) data.coverImageUrl = dto.coverImageUrl;
    if (dto.primaryColor !== undefined) {
      data.primaryColor = dto.primaryColor === null ? null : normalizeHexColor(dto.primaryColor);
    }
    if (dto.accentColor !== undefined) {
      data.accentColor = dto.accentColor === null ? null : normalizeHexColor(dto.accentColor);
    }

    if (Object.keys(data).length === 0) {
      return this.shapeResponse(await this.loadStudio(studioId));
    }

    const studio = await this.safeUpdate(studioId, data);
    return this.shapeResponse(studio);
  }

  async updateBookingRules(studioId: string, dto: UpdateBookingSettingsDto) {
    const data: Prisma.StudioUpdateInput = {};
    if (dto.allowWaitlist !== undefined) data.allowWaitlist = dto.allowWaitlist;
    if (dto.autoConfirmWaitlist !== undefined) data.autoConfirmWaitlist = dto.autoConfirmWaitlist;
    if (dto.cancellationWindowHours !== undefined) {
      data.cancellationWindowHours = dto.cancellationWindowHours;
    }
    if (dto.lateCancelPenaltyEnabled !== undefined) {
      data.lateCancelPenaltyEnabled = dto.lateCancelPenaltyEnabled;
    }
    if (dto.checkInWindowMinutes !== undefined) {
      data.checkInWindowMinutes = dto.checkInWindowMinutes;
    }

    if (Object.keys(data).length === 0) {
      return this.shapeResponse(await this.loadStudio(studioId));
    }

    const studio = await this.safeUpdate(studioId, data);
    return this.shapeResponse(studio);
  }

  async updateMobileConfig(studioId: string, dto: UpdateMobileConfigDto) {
    const data: Prisma.StudioUpdateInput = {};
    if (dto.appDisplayName !== undefined) data.appDisplayName = dto.appDisplayName;
    if (dto.appScheme !== undefined) data.appScheme = dto.appScheme;
    if (dto.expoSlug !== undefined) data.expoSlug = dto.expoSlug;
    if (dto.iosBundleIdentifier !== undefined) {
      data.iosBundleId = dto.iosBundleIdentifier;
    }
    if (dto.androidPackage !== undefined) {
      data.androidPackageName = dto.androidPackage;
    }

    if (Object.keys(data).length === 0) {
      return this.shapeResponse(await this.loadStudio(studioId));
    }

    const studio = await this.safeUpdate(studioId, data);
    return this.shapeResponse(studio);
  }

  private async safeUpdate(
    studioId: string,
    data: Prisma.StudioUpdateInput,
  ): Promise<StudioSettingsRow> {
    try {
      return await this.prisma.studio.update({
        where: { id: studioId },
        data,
        select: studioSettingsSelect,
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException('Studio not found');
      }
      throw e;
    }
  }

  private async loadStudio(studioId: string): Promise<StudioSettingsRow> {
    const studio = await this.prisma.studio.findFirst({
      where: { id: studioId, deletedAt: null },
      select: studioSettingsSelect,
    });
    if (!studio) {
      throw new NotFoundException('Studio not found');
    }
    return studio;
  }

  private shapeResponse(s: StudioSettingsRow) {
    const primaryPreview = s.primaryColor ?? s.brandPrimaryColor ?? '#7c3aed';
    const accentPreview = s.accentColor ?? s.brandSecondaryColor ?? '#22c55e';
    const logoPreview = s.logoUrl ?? s.brandLogoUrl ?? null;

    const mobile = {
      appDisplayName: s.appDisplayName ?? s.appName,
      appScheme: s.appScheme,
      expoSlug: s.expoSlug,
      iosBundleIdentifier: s.iosBundleId,
      androidPackage: s.androidPackageName,
    };

    const mobileWhiteLabelStatus = this.mobileWhiteLabelReady(mobile);

    return {
      general: {
        name: s.name,
        slug: s.slug,
        timezone: s.timezone,
        supportEmail: s.supportEmail,
        supportPhone: s.supportPhone,
        websiteUrl: s.websiteUrl,
        instagramHandle: s.instagramHandle,
        address: s.address,
        privacyUrl: s.privacyUrl,
        termsUrl: s.termsUrl,
      },
      branding: {
        logoUrl: s.logoUrl,
        coverImageUrl: s.coverImageUrl,
        primaryColor: s.primaryColor,
        accentColor: s.accentColor,
        legacyBrandLogoUrl: s.brandLogoUrl,
        legacyBrandPrimaryColor: s.brandPrimaryColor,
        legacyBrandSecondaryColor: s.brandSecondaryColor,
        brandIconUrl: s.brandIconUrl,
        brandSplashUrl: s.brandSplashUrl,
        effectivePrimaryColor: primaryPreview,
        effectiveAccentColor: accentPreview,
        effectiveLogoUrl: logoPreview,
      },
      bookingRules: {
        allowWaitlist: s.allowWaitlist,
        autoConfirmWaitlist: s.autoConfirmWaitlist,
        cancellationWindowHours: s.cancellationWindowHours,
        lateCancelPenaltyEnabled: s.lateCancelPenaltyEnabled,
        checkInWindowMinutes: s.checkInWindowMinutes,
      },
      mobile,
      mobileWhiteLabelStatus,
      storeLinks: {
        appStoreUrl: s.appStoreUrl,
        playStoreUrl: s.playStoreUrl,
      },
      updatedAt: s.updatedAt.toISOString(),
    };
  }

  private mobileWhiteLabelReady(m: {
    appDisplayName: string | null;
    appScheme: string | null;
    expoSlug: string | null;
    iosBundleIdentifier: string | null;
    androidPackage: string | null;
  }): 'ready' | 'incomplete' {
    const fields = [
      m.appDisplayName,
      m.appScheme,
      m.expoSlug,
      m.iosBundleIdentifier,
      m.androidPackage,
    ].map((x) => (typeof x === 'string' ? x.trim() : ''));
    return fields.every((x) => x.length > 0) ? 'ready' : 'incomplete';
  }
}

function normalizeHexColor(input: string): string {
  let str = input.trim();
  if (!str.startsWith('#')) {
    str = `#${str}`;
  }
  if (str.length === 4) {
    const r = str[1]!;
    const g = str[2]!;
    const b = str[3]!;
    str = `#${r}${r}${g}${g}${b}${b}`;
  }
  return str.toLowerCase();
}
