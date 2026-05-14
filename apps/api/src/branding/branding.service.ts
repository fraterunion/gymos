import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { UpdateBrandingDto } from './dto/update-branding.dto';

const publicBrandingSelect = {
  slug: true,
  name: true,
  timezone: true,
  appName: true,
  appDisplayName: true,
  brandPrimaryColor: true,
  brandSecondaryColor: true,
  primaryColor: true,
  accentColor: true,
  brandLogoUrl: true,
  logoUrl: true,
  brandIconUrl: true,
  brandSplashUrl: true,
  coverImageUrl: true,
  supportEmail: true,
  supportPhone: true,
  privacyUrl: true,
  termsUrl: true,
  iosBundleId: true,
  androidPackageName: true,
  appStoreUrl: true,
  playStoreUrl: true,
} satisfies Prisma.StudioSelect;

export type PublicBrandingResponse = {
  slug: string;
  name: string;
  timezone: string;
  appName: string | null;
  brandPrimaryColor: string | null;
  brandSecondaryColor: string | null;
  brandLogoUrl: string | null;
  brandIconUrl: string | null;
  brandSplashUrl: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  privacyUrl: string | null;
  termsUrl: string | null;
  iosBundleId: string | null;
  androidPackageName: string | null;
  appStoreUrl: string | null;
  playStoreUrl: string | null;
};

const adminBrandingSelect = {
  ...publicBrandingSelect,
  id: true,
} satisfies Prisma.StudioSelect;

export type AdminBrandingResponse = Prisma.StudioGetPayload<{ select: typeof adminBrandingSelect }>;

@Injectable()
export class BrandingService {
  constructor(private readonly prisma: PrismaService) {}

  async getPublicBrandingBySlug(slug: string): Promise<PublicBrandingResponse> {
    const s = await this.prisma.studio.findFirst({
      where: { slug, deletedAt: null },
      select: publicBrandingSelect,
    });
    if (!s) {
      throw new NotFoundException('Studio not found');
    }
    return {
      slug: s.slug,
      name: s.name,
      timezone: s.timezone,
      appName: s.appDisplayName ?? s.appName,
      brandPrimaryColor: s.primaryColor ?? s.brandPrimaryColor,
      brandSecondaryColor: s.accentColor ?? s.brandSecondaryColor,
      brandLogoUrl: s.logoUrl ?? s.brandLogoUrl,
      brandIconUrl: s.brandIconUrl,
      brandSplashUrl: s.brandSplashUrl,
      supportEmail: s.supportEmail,
      supportPhone: s.supportPhone,
      privacyUrl: s.privacyUrl,
      termsUrl: s.termsUrl,
      iosBundleId: s.iosBundleId,
      androidPackageName: s.androidPackageName,
      appStoreUrl: s.appStoreUrl,
      playStoreUrl: s.playStoreUrl,
    };
  }

  async getBrandingForStudio(studioId: string): Promise<AdminBrandingResponse> {
    const studio = await this.prisma.studio.findFirst({
      where: { id: studioId, deletedAt: null },
      select: adminBrandingSelect,
    });
    if (!studio) {
      throw new NotFoundException('Studio not found');
    }
    return studio;
  }

  async updateBranding(studioId: string, dto: UpdateBrandingDto): Promise<AdminBrandingResponse> {
    const data: Prisma.StudioUpdateInput = {};
    if (dto.appName !== undefined) {
      data.appName = dto.appName;
    }
    if (dto.brandPrimaryColor !== undefined) {
      data.brandPrimaryColor = normalizeHexColor(dto.brandPrimaryColor);
    }
    if (dto.brandSecondaryColor !== undefined) {
      data.brandSecondaryColor = normalizeHexColor(dto.brandSecondaryColor);
    }
    if (dto.brandLogoUrl !== undefined) {
      data.brandLogoUrl = dto.brandLogoUrl;
    }
    if (dto.brandIconUrl !== undefined) {
      data.brandIconUrl = dto.brandIconUrl;
    }
    if (dto.brandSplashUrl !== undefined) {
      data.brandSplashUrl = dto.brandSplashUrl;
    }
    if (dto.supportEmail !== undefined) {
      data.supportEmail = dto.supportEmail;
    }
    if (dto.supportPhone !== undefined) {
      data.supportPhone = dto.supportPhone;
    }
    if (dto.privacyUrl !== undefined) {
      data.privacyUrl = dto.privacyUrl;
    }
    if (dto.termsUrl !== undefined) {
      data.termsUrl = dto.termsUrl;
    }
    if (dto.iosBundleId !== undefined) {
      data.iosBundleId = dto.iosBundleId;
    }
    if (dto.androidPackageName !== undefined) {
      data.androidPackageName = dto.androidPackageName;
    }
    if (dto.appStoreUrl !== undefined) {
      data.appStoreUrl = dto.appStoreUrl;
    }
    if (dto.playStoreUrl !== undefined) {
      data.playStoreUrl = dto.playStoreUrl;
    }

    if (Object.keys(data).length === 0) {
      return this.getBrandingForStudio(studioId);
    }

    try {
      return await this.prisma.studio.update({
        where: { id: studioId },
        data,
        select: adminBrandingSelect,
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException('Studio not found');
      }
      throw e;
    }
  }
}

function normalizeHexColor(input: string): string {
  let s = input.trim();
  if (!s.startsWith('#')) {
    s = `#${s}`;
  }
  if (s.length === 4) {
    const r = s[1]!;
    const g = s[2]!;
    const b = s[3]!;
    s = `#${r}${r}${g}${g}${b}${b}`;
  }
  return s.toLowerCase();
}
