import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type WalletPassBranding = {
  organizationName: string;
  /** Selects the studio's checked-in Wallet artwork (see wallet-brand-assets.ts). */
  studioSlug: string;
  logoUrl: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  privacyUrl: string | null;
  termsUrl: string | null;
  /** Apple pass.json wants "rgb(r,g,b)"; Google Wallet objects want "#rrggbb". Same color,
   *  both formats precomputed once here so neither provider re-derives the other's shape. */
  backgroundColorRgb: string;
  backgroundColorHex: string;
  foregroundColorRgb: string;
  labelColorRgb: string;
};

/**
 * The pass surface is deliberately a fixed graphite/white credential palette rather than the
 * studio's `brandPrimaryColor`.
 *
 * `brandPrimaryColor` is an ACCENT — the mobile app paints it as a 3px rule on top of a
 * `#0A0A0A` card (see mi-pase.tsx), never as a full-bleed surface. Stretching it across the
 * whole pass both diverged from the in-app Mi Pase card and made contrast a function of
 * whatever hex a studio happened to save: ARES' `#0f172a` rendered as flat navy, and a light
 * brand colour would have produced white-on-white text. Brand identity belongs to the logo
 * image, which is Apple's intended mechanism and how premium passes actually work.
 */
const PASS_BACKGROUND_HEX = '#0a0a0a';
const PASS_BACKGROUND_RGB = 'rgb(10,10,10)';
const PASS_FOREGROUND_RGB = 'rgb(255,255,255)';
const PASS_LABEL_RGB = 'rgb(160,160,160)';

const brandingSelect = {
  name: true,
  slug: true,
  brandLogoUrl: true,
  logoUrl: true,
  supportEmail: true,
  supportPhone: true,
  privacyUrl: true,
  termsUrl: true,
  deletedAt: true,
} as const;

@Injectable()
export class WalletPassBrandingResolver {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(studioId: string): Promise<WalletPassBranding> {
    const studio = await this.prisma.studio.findFirst({
      where: { id: studioId, deletedAt: null },
      select: brandingSelect,
    });
    if (!studio) {
      throw new NotFoundException('Studio not found');
    }

    return {
      organizationName: studio.name,
      studioSlug: studio.slug,
      logoUrl: studio.brandLogoUrl ?? studio.logoUrl ?? null,
      supportEmail: studio.supportEmail,
      supportPhone: studio.supportPhone,
      privacyUrl: studio.privacyUrl,
      termsUrl: studio.termsUrl,
      backgroundColorRgb: PASS_BACKGROUND_RGB,
      backgroundColorHex: PASS_BACKGROUND_HEX,
      foregroundColorRgb: PASS_FOREGROUND_RGB,
      labelColorRgb: PASS_LABEL_RGB,
    };
  }
}
