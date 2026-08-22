import { NotFoundException } from '@nestjs/common';
import { WalletPassBrandingResolver } from './wallet-pass-branding.resolver';

describe('WalletPassBrandingResolver', () => {
  const prisma = { studio: { findFirst: jest.fn() } };
  const resolver = new WalletPassBrandingResolver(prisma as never);

  beforeEach(() => jest.clearAllMocks());

  it('resolves the premium graphite/white credential palette', async () => {
    prisma.studio.findFirst.mockResolvedValue({
      name: 'ARES Training Club',
      slug: 'ares-fitness',
      brandLogoUrl: null,
      logoUrl: null,
      supportEmail: null,
      supportPhone: null,
      privacyUrl: null,
      termsUrl: null,
    });

    const branding = await resolver.resolve('studio-1');

    expect(branding.organizationName).toBe('ARES Training Club');
    expect(branding.studioSlug).toBe('ares-fitness');
    expect(branding.backgroundColorRgb).toBe('rgb(10,10,10)');
    expect(branding.backgroundColorHex).toBe('#0a0a0a');
    expect(branding.foregroundColorRgb).toBe('rgb(255,255,255)');
  });

  // brandPrimaryColor is an accent (a 3px rule in the app), not a surface. Painting a whole
  // pass with it made contrast depend on whatever hex a studio saved — a light brand colour
  // would have rendered white text on a white pass.
  it('never lets a studio accent colour become the pass background', async () => {
    prisma.studio.findFirst.mockResolvedValue({
      name: 'Pilates Plus',
      slug: 'pilates-plus',
      brandLogoUrl: 'https://cdn.example.com/logo.png',
      logoUrl: null,
      supportEmail: 'hola@pilatesplus.mx',
      supportPhone: null,
      privacyUrl: null,
      termsUrl: 'https://pilatesplus.mx/terms',
    });

    const branding = await resolver.resolve('studio-2');

    expect(branding.backgroundColorRgb).toBe('rgb(10,10,10)');
    expect(branding.backgroundColorHex).toBe('#0a0a0a');
    expect(branding.logoUrl).toBe('https://cdn.example.com/logo.png');
    expect(branding.termsUrl).toBe('https://pilatesplus.mx/terms');
  });

  it('throws NotFoundException for an unknown or soft-deleted studio', async () => {
    prisma.studio.findFirst.mockResolvedValue(null);
    await expect(resolver.resolve('gone')).rejects.toThrow(NotFoundException);
  });
});
