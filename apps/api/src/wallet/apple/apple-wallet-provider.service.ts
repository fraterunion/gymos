import { createHash } from 'node:crypto';
import { ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import JSZip from 'jszip';
import { buildWalletCredentialBarcode } from '../wallet-credential.constants';
import type { WalletPassBranding } from '../wallet-pass-branding.resolver';
import { APPLE_WALLET_ENV_KEYS, WALLET_APPLE_NOT_CONFIGURED_MESSAGE } from './apple-wallet.constants';
import { buildPassJson, parseRgbFunction } from './pkpass-builder';
import { loadP12, signManifest } from './pkpass-signer';
import { solidColorPng } from './solid-color-png';
import { loadAppleBrandImages } from './wallet-brand-assets';

export type BuildPkpassInput = {
  walletCredentialId: string;
  rawCredential: string;
  memberName: string;
  planName: string | null;
  branding: WalletPassBranding;
};

type AppleWalletConfig = {
  teamIdentifier: string;
  passTypeIdentifier: string;
  p12Base64: string;
  p12Password: string;
  wwdrPemBase64: string;
};

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

@Injectable()
export class AppleWalletProvider {
  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return APPLE_WALLET_ENV_KEYS.every((key) => !!this.config.get<string>(key)?.trim());
  }

  /** Builds and signs a static .pkpass. Throws WALLET_APPLE_NOT_CONFIGURED (never a raw
   *  crypto/signing exception) when Apple credentials are absent. */
  async buildPkpass(input: BuildPkpassInput): Promise<Buffer> {
    const cfg = this.requireConfig();

    // A studio with checked-in Wallet artwork gets its real icon + logo; anyone else keeps the
    // generated placeholder icons and falls back to `logoText` inside buildPassJson, so the
    // collapsed pass is still identifiable either way.
    const brandImages = loadAppleBrandImages(input.branding.studioSlug);
    const images: Record<string, Buffer> = brandImages ?? this.placeholderIcons(input.branding.backgroundColorRgb);

    const passJson = buildPassJson({
      passTypeIdentifier: cfg.passTypeIdentifier,
      teamIdentifier: cfg.teamIdentifier,
      serialNumber: input.walletCredentialId,
      organizationName: input.branding.organizationName,
      memberName: input.memberName,
      planName: input.planName,
      barcodeMessage: buildWalletCredentialBarcode(input.rawCredential),
      backgroundColorRgb: input.branding.backgroundColorRgb,
      foregroundColorRgb: input.branding.foregroundColorRgb,
      labelColorRgb: input.branding.labelColorRgb,
      supportEmail: input.branding.supportEmail,
      termsUrl: input.branding.termsUrl,
      hasLogoImage: !!brandImages,
    });
    const passJsonBuffer = Buffer.from(JSON.stringify(passJson), 'utf8');

    // Every file in the bundle except manifest.json and signature must be hashed here — Wallet
    // rejects a pass whose manifest omits, or disagrees with, any packaged asset.
    const manifest: Record<string, string> = { 'pass.json': sha1Hex(passJsonBuffer) };
    for (const [name, data] of Object.entries(images)) {
      manifest[name] = sha1Hex(data);
    }
    const manifestBuffer = Buffer.from(JSON.stringify(manifest), 'utf8');

    const certificate = loadP12(cfg.p12Base64, cfg.p12Password);
    const wwdrPem = Buffer.from(cfg.wwdrPemBase64, 'base64').toString('utf8');
    const signature = signManifest(manifestBuffer, certificate, wwdrPem);

    const zip = new JSZip();
    zip.file('pass.json', passJsonBuffer);
    zip.file('manifest.json', manifestBuffer);
    zip.file('signature', signature);
    for (const [name, data] of Object.entries(images)) {
      zip.file(name, data);
    }

    return zip.generateAsync({ type: 'nodebuffer' });
  }

  private placeholderIcons(backgroundColorRgb: string): Record<string, Buffer> {
    const [r, g, b] = parseRgbFunction(backgroundColorRgb);
    return {
      'icon.png': solidColorPng(29, [r, g, b]),
      'icon@2x.png': solidColorPng(58, [r, g, b]),
      'icon@3x.png': solidColorPng(87, [r, g, b]),
    };
  }

  private requireConfig(): AppleWalletConfig {
    if (!this.isConfigured()) {
      throw new ConflictException(WALLET_APPLE_NOT_CONFIGURED_MESSAGE);
    }
    return {
      teamIdentifier: this.config.get<string>('WALLET_APPLE_TEAM_ID')!,
      passTypeIdentifier: this.config.get<string>('WALLET_APPLE_PASS_TYPE_ID')!,
      p12Base64: this.config.get<string>('WALLET_APPLE_SIGNING_CERT_P12_BASE64')!,
      p12Password: this.config.get<string>('WALLET_APPLE_SIGNING_CERT_PASSWORD')!,
      wwdrPemBase64: this.config.get<string>('WALLET_APPLE_WWDR_CERT_PEM_BASE64')!,
    };
  }
}
