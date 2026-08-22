import { NotFoundException } from '@nestjs/common';
import { WalletPassBrandingResolver } from './wallet-pass-branding.resolver';

describe('WalletPassBrandingResolver', () => {
  const prisma = { studio: { findFirst: jest.fn() } };
  const resolver = new WalletPassBrandingResolver(prisma as never);

  beforeEach(() => jest.clearAllMocks());

  it('falls back to the premium black/white default when no custom brand color is set', async () => {
    prisma.studio.findFirst.mockResolvedValue({
      name: 'ARES Training Club',
      brandLogoUrl: null,
      logoUrl: null,
      brandPrimaryColor: null,
      supportEmail: null,
      supportPhone: null,
      privacyUrl: null,
      termsUrl: null,
    });

    const branding = await resolver.resolve('studio-1');

    expect(branding.organizationName).toBe('ARES Training Club');
    expect(branding.backgroundColorRgb).toBe('rgb(10,10,10)');
    expect(branding.backgroundColorHex).toBe('#0a0a0a');
    expect(branding.foregroundColorRgb).toBe('rgb(255,255,255)');
  });

  it('uses the studio brandPrimaryColor when configured, in both rgb() and hex form', async () => {
    prisma.studio.findFirst.mockResolvedValue({
      name: 'Pilates Plus',
      brandLogoUrl: 'https://cdn.example.com/logo.png',
      logoUrl: null,
      brandPrimaryColor: '#FF6600',
      supportEmail: 'hola@pilatesplus.mx',
      supportPhone: null,
      privacyUrl: null,
      termsUrl: 'https://pilatesplus.mx/terms',
    });

    const branding = await resolver.resolve('studio-2');

    expect(branding.backgroundColorRgb).toBe('rgb(255,102,0)');
    expect(branding.backgroundColorHex).toBe('#ff6600');
    expect(branding.logoUrl).toBe('https://cdn.example.com/logo.png');
    expect(branding.termsUrl).toBe('https://pilatesplus.mx/terms');
  });

  it('throws NotFoundException for an unknown or soft-deleted studio', async () => {
    prisma.studio.findFirst.mockResolvedValue(null);
    await expect(resolver.resolve('gone')).rejects.toThrow(NotFoundException);
  });
});
