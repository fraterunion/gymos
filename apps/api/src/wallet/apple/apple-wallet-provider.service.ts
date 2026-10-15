import { createHash } from 'node:crypto';
import { ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import JSZip from 'jszip';
import * as forge from 'node-forge';
import { buildWalletCredentialBarcode } from '../wallet-credential.constants';
import type { WalletPassBranding } from '../wallet-pass-branding.resolver';
import type { WalletPassDisplay } from '../access/wallet-access-display';
import { APPLE_WALLET_ENV_KEYS, WALLET_APPLE_NOT_CONFIGURED_MESSAGE } from './apple-wallet.constants';
import { buildPassJson, parseRgbFunction } from './pkpass-builder';
import { buildDynamicPassJson, computePassContentHash } from './pkpass-dynamic-builder';
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

export type BuildDynamicPkpassInput = {
  walletCredentialId: string;
  rawCredential: string;
  memberName: string;
  branding: WalletPassBranding;
  webServiceURL: string;
  authenticationToken: string;
  display: WalletPassDisplay;
};

/** A fully rendered, not yet signed, pass bundle and its deterministic content hash. */
export type RenderedPass = {
  passJson: Buffer;
  images: Record<string, Buffer>;
  contentHash: string;
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
    const { images, hasLogoImage } = this.bundleImages(input.branding);

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
      hasLogoImage,
    });
    return this.packageAndSign(cfg, Buffer.from(JSON.stringify(passJson), 'utf8'), images);
  }

  /**
   * Renders a DYNAMIC pass bundle without signing it, so the caller can compare its content
   * hash with the stored one and skip signing (and versioning, and pushing) when nothing a
   * member would see has changed.
   */
  renderDynamicPass(input: BuildDynamicPkpassInput): RenderedPass {
    const cfg = this.requireConfig();
    const { images, hasLogoImage } = this.bundleImages(input.branding);
    const passJson = buildDynamicPassJson({
      passTypeIdentifier: cfg.passTypeIdentifier,
      teamIdentifier: cfg.teamIdentifier,
      serialNumber: input.walletCredentialId,
      organizationName: input.branding.organizationName,
      memberName: input.memberName,
      barcodeMessage: buildWalletCredentialBarcode(input.rawCredential),
      backgroundColorRgb: input.branding.backgroundColorRgb,
      foregroundColorRgb: input.branding.foregroundColorRgb,
      labelColorRgb: input.branding.labelColorRgb,
      supportEmail: input.branding.supportEmail,
      termsUrl: input.branding.termsUrl,
      hasLogoImage,
      webServiceURL: input.webServiceURL,
      authenticationToken: input.authenticationToken,
      display: input.display,
    });
    const passJsonBuffer = Buffer.from(JSON.stringify(passJson), 'utf8');
    return { passJson: passJsonBuffer, images, contentHash: computePassContentHash(passJsonBuffer, images) };
  }

  /** Signs and zips a bundle produced by renderDynamicPass. CPU only — no I/O, no DB. */
  async signRenderedPass(rendered: RenderedPass): Promise<Buffer> {
    return this.packageAndSign(this.requireConfig(), rendered.passJson, rendered.images);
  }

  /**
   * The Pass Type ID certificate and key as PEM, for APNs TLS client authentication: Apple
   * requires pass-update pushes to use the same identity that signed the pass.
   */
  apnsClientIdentity(): { certPem: string; keyPem: string; passTypeIdentifier: string } {
    const cfg = this.requireConfig();
    const certificate = loadP12(cfg.p12Base64, cfg.p12Password);
    return {
      certPem: forge.pki.certificateToPem(certificate.cert),
      keyPem: forge.pki.privateKeyToPem(certificate.privateKey as forge.pki.rsa.PrivateKey),
      passTypeIdentifier: cfg.passTypeIdentifier,
    };
  }

  /**
   * Identity and validity of the configured signing certificate (no key material). Used by the
   * refresh worker's expiry monitoring and the operator diagnostics.
   */
  signingCertificateInfo(): {
    notBefore: Date;
    notAfter: Date;
    passTypeIdentifier: string | null;
    teamIdentifier: string | null;
    serialNumber: string;
  } {
    const cfg = this.requireConfig();
    const { cert } = loadP12(cfg.p12Base64, cfg.p12Password);
    const attribute = (oid: string): string | null => {
      const value = cert.subject.attributes.find((a) => a.type === oid)?.value;
      return typeof value === 'string' ? value : null;
    };
    return {
      notBefore: cert.validity.notBefore,
      notAfter: cert.validity.notAfter,
      passTypeIdentifier: attribute('0.9.2342.19200300.100.1.1'), // UID
      teamIdentifier: attribute('2.5.4.11'), // OU
      serialNumber: cert.serialNumber,
    };
  }

  /** The configured Pass Type ID (PassKit requests must name exactly this one). */
  passTypeIdentifier(): string {
    return this.requireConfig().passTypeIdentifier;
  }

  /**
   * A studio with checked-in Wallet artwork gets its real icon + logo; anyone else keeps the
   * generated placeholder icons and falls back to `logoText` in the pass builders, so the
   * collapsed pass is still identifiable either way.
   */
  private bundleImages(branding: WalletPassBranding): { images: Record<string, Buffer>; hasLogoImage: boolean } {
    const brandImages = loadAppleBrandImages(branding.studioSlug);
    return {
      images: brandImages ?? this.placeholderIcons(branding.backgroundColorRgb),
      hasLogoImage: !!brandImages,
    };
  }

  private async packageAndSign(
    cfg: AppleWalletConfig,
    passJsonBuffer: Buffer,
    images: Record<string, Buffer>,
  ): Promise<Buffer> {
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
