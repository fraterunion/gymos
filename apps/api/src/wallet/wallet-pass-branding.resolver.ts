import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type WalletPassBranding = {
  organizationName: string;
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
 * Default ARES-style visual identity — premium, minimal, black/graphite/white. Every studio
 * gets this unless it has set its own brandPrimaryColor; there is nothing ARES-specific in
 * this module itself, only the fallback aesthetic (see Phase B/2B: "closer to Apple Fitness
 * / Equinox, not a coupon"), which any future tenant inherits until they customize it.
 */
const DEFAULT_BACKGROUND_HEX = '#0a0a0a';
const DEFAULT_BACKGROUND_RGB = 'rgb(10,10,10)';
const DEFAULT_FOREGROUND_RGB = 'rgb(255,255,255)';
const DEFAULT_LABEL_RGB = 'rgb(160,160,160)';

function normalizeHex(hex: string | null): string | null {
  if (!hex) return null;
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  return match ? `#${match[1]!.toLowerCase()}` : null;
}

const brandingSelect = {
  name: true,
  brandLogoUrl: true,
  logoUrl: true,
  brandPrimaryColor: true,
  supportEmail: true,
  supportPhone: true,
  privacyUrl: true,
  termsUrl: true,
  deletedAt: true,
} as const;

function hexToRgbFunction(hex: string | null): string | null {
  if (!hex) return null;
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!match) return null;
  const value = match[1]!;
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgb(${r},${g},${b})`;
}

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
      logoUrl: studio.brandLogoUrl ?? studio.logoUrl ?? null,
      supportEmail: studio.supportEmail,
      supportPhone: studio.supportPhone,
      privacyUrl: studio.privacyUrl,
      termsUrl: studio.termsUrl,
      backgroundColorRgb: hexToRgbFunction(studio.brandPrimaryColor) ?? DEFAULT_BACKGROUND_RGB,
      backgroundColorHex: normalizeHex(studio.brandPrimaryColor) ?? DEFAULT_BACKGROUND_HEX,
      foregroundColorRgb: DEFAULT_FOREGROUND_RGB,
      labelColorRgb: DEFAULT_LABEL_RGB,
    };
  }
}
