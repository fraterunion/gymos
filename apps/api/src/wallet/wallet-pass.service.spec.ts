import { ConflictException, ForbiddenException } from '@nestjs/common';
import { WalletPassPlatform } from '@prisma/client';
import JSZip from 'jszip';
import * as jwt from 'jsonwebtoken';
import { WalletPassService } from './wallet-pass.service';

/** A minimal-but-real .pkpass zip fixture — just enough for extractBarcodeMessageFromPkpass
 *  to parse, without involving real signing (Phase 3.2 recovery tests only need pass.json). */
async function buildFixturePkpass(barcodeMessage: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('pass.json', JSON.stringify({ barcodes: [{ message: barcodeMessage }] }));
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('WalletPassService', () => {
  const prisma = {
    studioMembership: { findFirst: jest.fn() },
    walletPassArtifact: { findUnique: jest.fn(), upsert: jest.fn() },
    user: { findUniqueOrThrow: jest.fn() },
    subscription: { findFirst: jest.fn() },
  };
  const walletCredentials = { issue: jest.fn(), reissue: jest.fn(), resolve: jest.fn() };
  const branding = { resolve: jest.fn() };
  const appleProvider = { buildPkpass: jest.fn(), isConfigured: jest.fn() };
  const googleProvider = {
    ensureClassAndObject: jest.fn(),
    buildSaveUrl: jest.fn(),
    isConfigured: jest.fn(),
    getExistingObjectBarcodeValue: jest.fn(),
  };
  const config = { get: jest.fn(), getOrThrow: jest.fn(() => 'test-jwt-qr-secret-min-32-chars!!') };

  const service = new WalletPassService(
    prisma as never,
    config as never,
    walletCredentials as never,
    branding as never,
    appleProvider as never,
    googleProvider as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.studioMembership.findFirst.mockResolvedValue({ user: { deletedAt: null } });
    prisma.user.findUniqueOrThrow.mockResolvedValue({ firstName: 'Ivonne', lastName: 'Araujo' });
    prisma.subscription.findFirst.mockResolvedValue({ membershipPlan: { name: 'Full Access' } });
    branding.resolve.mockResolvedValue({ organizationName: 'ARES Training Club' });
    appleProvider.isConfigured.mockReturnValue(true);
    googleProvider.isConfigured.mockReturnValue(true);
  });

  describe('pass issuance eligibility', () => {
    it('denies a member with no active StudioMembership', async () => {
      prisma.studioMembership.findFirst.mockResolvedValue(null);
      await expect(service.getApplePass('studio-1', 'user-1')).rejects.toThrow(ForbiddenException);
      expect(walletCredentials.issue).not.toHaveBeenCalled();
    });

    it('denies a soft-deleted member even if a StudioMembership row exists', async () => {
      prisma.studioMembership.findFirst.mockResolvedValue({ user: { deletedAt: new Date() } });
      await expect(service.getApplePass('studio-1', 'user-1')).rejects.toThrow(ForbiddenException);
    });

    it('does not require an active subscription/entitlement to issue a pass (Phase 1 principle)', async () => {
      prisma.subscription.findFirst.mockResolvedValue(null); // no active plan
      walletCredentials.issue.mockResolvedValue({
        credential: { id: 'wc1' },
        rawCredential: 'raw1',
      });
      prisma.walletPassArtifact.findUnique.mockResolvedValue(null);
      appleProvider.buildPkpass.mockResolvedValue(Buffer.from('pkpass-bytes'));
      prisma.walletPassArtifact.upsert.mockResolvedValue({ pkpassData: Buffer.from('pkpass-bytes') });
      googleProvider.ensureClassAndObject.mockResolvedValue({ objectId: 'obj1' });

      const result = await service.getApplePass('studio-1', 'user-1');
      expect(result).toBeInstanceOf(Buffer);
    });
  });

  describe('first-ever issuance — eager dual-provisioning', () => {
    beforeEach(() => {
      walletCredentials.issue.mockResolvedValue({ credential: { id: 'wc1' }, rawCredential: 'raw1' });
      prisma.walletPassArtifact.findUnique.mockResolvedValue(null);
      appleProvider.buildPkpass.mockResolvedValue(Buffer.from('pkpass-bytes'));
      prisma.walletPassArtifact.upsert.mockResolvedValue({ pkpassData: Buffer.from('pkpass-bytes') });
      googleProvider.ensureClassAndObject.mockResolvedValue({ objectId: 'obj1' });
    });

    it('requesting Apple first also provisions Google in the background, using the same raw value', async () => {
      await service.getApplePass('studio-1', 'user-1');
      expect(appleProvider.buildPkpass).toHaveBeenCalledWith(expect.objectContaining({ rawCredential: 'raw1' }));
      expect(googleProvider.ensureClassAndObject).toHaveBeenCalledWith(
        expect.objectContaining({ rawCredential: 'raw1' }),
      );
    });

    it('a background-provisioning failure for the OTHER platform does not fail the requested response', async () => {
      googleProvider.ensureClassAndObject.mockRejectedValue(new Error('google down'));
      await expect(service.getApplePass('studio-1', 'user-1')).resolves.toBeInstanceOf(Buffer);
    });

    it('does not attempt background provisioning for a platform that is not configured', async () => {
      googleProvider.isConfigured.mockReturnValue(false);
      await service.getApplePass('studio-1', 'user-1');
      expect(googleProvider.ensureClassAndObject).not.toHaveBeenCalled();
    });
  });

  describe('re-download (existing credential, artifact already provisioned)', () => {
    it('re-serves the stored .pkpass without calling issue() a second raw-generating time or re-signing', async () => {
      walletCredentials.issue.mockResolvedValue({ credential: { id: 'wc1' }, rawCredential: null });
      prisma.walletPassArtifact.findUnique.mockResolvedValue({ pkpassData: Buffer.from('already-signed') });

      const result = await service.getApplePass('studio-1', 'user-1');

      expect(result).toEqual(Buffer.from('already-signed'));
      expect(appleProvider.buildPkpass).not.toHaveBeenCalled();
    });

    it('re-mints a fresh Google save URL from the existing objectId without recreating the object', async () => {
      walletCredentials.issue.mockResolvedValue({ credential: { id: 'wc1' }, rawCredential: null });
      prisma.walletPassArtifact.findUnique.mockResolvedValue({ googleObjectId: 'existing-obj' });
      googleProvider.buildSaveUrl.mockReturnValue('https://pay.google.com/gp/v/save/tok');

      const result = await service.getGooglePass('studio-1', 'user-1');

      expect(result).toEqual({ saveUrl: 'https://pay.google.com/gp/v/save/tok' });
      expect(googleProvider.ensureClassAndObject).not.toHaveBeenCalled();
      expect(googleProvider.buildSaveUrl).toHaveBeenCalledWith('existing-obj');
    });
  });

  describe('reissue-required (existing credential, no artifact, no raw value available)', () => {
    it('throws WALLET_PASS_REISSUE_REQUIRED instead of silently reissuing the credential', async () => {
      walletCredentials.issue.mockResolvedValue({ credential: { id: 'wc1' }, rawCredential: null });
      prisma.walletPassArtifact.findUnique.mockResolvedValue(null);

      await expect(service.getApplePass('studio-1', 'user-1')).rejects.toThrow('WALLET_PASS_REISSUE_REQUIRED');
      await expect(service.getApplePass('studio-1', 'user-1')).rejects.toThrow(ConflictException);
      expect(appleProvider.buildPkpass).not.toHaveBeenCalled();
    });
  });

  describe('not-configured takes precedence over reissue-required', () => {
    // Regression: getBarcode's eager background provisioning is a silent no-op when a
    // provider isn't configured (see 'first-ever issuance' below) — it still consumes the
    // one-time raw credential without leaving an artifact behind. Without checking
    // isConfigured() first, a later on-demand getApplePass/getGooglePass call would see
    // exactly the same "no artifact, no raw" shape as a genuine reissue case and misreport
    // a routine "not set up in this environment" as an alarming REISSUE_REQUIRED.
    it('getApplePass throws WALLET_APPLE_NOT_CONFIGURED, not REISSUE_REQUIRED, when Apple is unconfigured', async () => {
      appleProvider.isConfigured.mockReturnValue(false);
      walletCredentials.issue.mockResolvedValue({ credential: { id: 'wc1' }, rawCredential: null });
      prisma.walletPassArtifact.findUnique.mockResolvedValue(null);

      await expect(service.getApplePass('studio-1', 'user-1')).rejects.toThrow('WALLET_APPLE_NOT_CONFIGURED');
      expect(walletCredentials.issue).not.toHaveBeenCalled();
    });

    it('getGooglePass throws WALLET_GOOGLE_NOT_CONFIGURED, not REISSUE_REQUIRED, when Google is unconfigured', async () => {
      googleProvider.isConfigured.mockReturnValue(false);
      walletCredentials.issue.mockResolvedValue({ credential: { id: 'wc1' }, rawCredential: null });
      prisma.walletPassArtifact.findUnique.mockResolvedValue(null);

      await expect(service.getGooglePass('studio-1', 'user-1')).rejects.toThrow('WALLET_GOOGLE_NOT_CONFIGURED');
      expect(walletCredentials.issue).not.toHaveBeenCalled();
    });
  });

  describe('reissueAndProvision', () => {
    beforeEach(() => {
      walletCredentials.reissue.mockResolvedValue({
        credential: { id: 'wc-new' },
        rawCredential: 'fresh-raw',
      });
      // First check inside tryProvisionApple/tryProvisionGoogle finds nothing (triggers
      // provisioning); the second read (after provisioning) finds what was just written.
      prisma.walletPassArtifact.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ pkpassData: Buffer.from('new-pkpass'), googleObjectId: 'new-obj' });
      appleProvider.buildPkpass.mockResolvedValue(Buffer.from('new-pkpass'));
      prisma.walletPassArtifact.upsert.mockResolvedValue({
        pkpassData: Buffer.from('new-pkpass'),
        googleObjectId: 'new-obj',
      });
      googleProvider.ensureClassAndObject.mockResolvedValue({ objectId: 'new-obj' });
      googleProvider.buildSaveUrl.mockReturnValue('https://pay.google.com/gp/v/save/new');
    });

    it('returns the fresh in-app QR barcode immediately using the freshly reissued raw value', async () => {
      const result = await service.reissueAndProvision('studio-1', 'user-1');
      expect(walletCredentials.reissue).toHaveBeenCalledWith('studio-1', 'user-1');
      expect(result.barcode).toBe('gymos:v1:fresh-raw');
    });

    it('provisions Apple using the freshly reissued raw value', async () => {
      await service.reissueAndProvision('studio-1', 'user-1');
      expect(appleProvider.buildPkpass).toHaveBeenCalledWith(expect.objectContaining({ rawCredential: 'fresh-raw' }));
    });

    it('also provisions Google when configured, reporting it available', async () => {
      const result = await service.reissueAndProvision('studio-1', 'user-1');
      expect(result.googleWalletAvailable).toBe(true);
      expect(result.applePkpassAvailable).toBe(true);
    });

    it('ATOMICITY: an Apple provisioning failure does not fail the reissue — the barcode is still returned', async () => {
      appleProvider.buildPkpass.mockRejectedValue(new Error('signing failed'));
      prisma.walletPassArtifact.findUnique.mockReset();
      prisma.walletPassArtifact.findUnique
        .mockResolvedValueOnce(null) // tryProvisionApple's existence check
        .mockResolvedValueOnce(null) // tryProvisionGoogle's existence check
        .mockResolvedValueOnce(null) // post-provision APPLE read — provisioning failed, nothing written
        .mockResolvedValue({ googleObjectId: 'new-obj' }); // post-provision GOOGLE read

      const result = await service.reissueAndProvision('studio-1', 'user-1');

      expect(result.barcode).toBe('gymos:v1:fresh-raw');
      expect(result.applePkpassAvailable).toBe(false);
      expect(result.googleWalletAvailable).toBe(true);
    });

    it('ATOMICITY: an unconfigured Apple provider does not fail the reissue', async () => {
      appleProvider.isConfigured.mockReturnValue(false);
      prisma.walletPassArtifact.findUnique.mockReset();
      prisma.walletPassArtifact.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ googleObjectId: 'new-obj' });

      const result = await service.reissueAndProvision('studio-1', 'user-1');

      expect(result.barcode).toBe('gymos:v1:fresh-raw');
      expect(result.applePkpassAvailable).toBe(false);
      expect(appleProvider.buildPkpass).not.toHaveBeenCalled();
    });

    it('ATOMICITY: a Google provisioning failure does not fail the reissue — the barcode is still returned', async () => {
      googleProvider.ensureClassAndObject.mockRejectedValue(new Error('google down'));
      prisma.walletPassArtifact.findUnique.mockReset();
      prisma.walletPassArtifact.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ pkpassData: Buffer.from('new-pkpass') })
        .mockResolvedValue(null);

      const result = await service.reissueAndProvision('studio-1', 'user-1');

      expect(result.barcode).toBe('gymos:v1:fresh-raw');
      expect(result.applePkpassAvailable).toBe(true);
      expect(result.googleWalletAvailable).toBe(false);
    });

    it('ATOMICITY: BOTH providers failing still returns a working barcode — never leaves the member with nothing', async () => {
      appleProvider.buildPkpass.mockRejectedValue(new Error('signing failed'));
      googleProvider.ensureClassAndObject.mockRejectedValue(new Error('google down'));
      prisma.walletPassArtifact.findUnique.mockReset();
      prisma.walletPassArtifact.findUnique.mockResolvedValue(null);

      const result = await service.reissueAndProvision('studio-1', 'user-1');

      expect(result.barcode).toBe('gymos:v1:fresh-raw');
      expect(result.applePkpassAvailable).toBe(false);
      expect(result.googleWalletAvailable).toBe(false);
    });

    it('denies reissue for a member with no active StudioMembership', async () => {
      prisma.studioMembership.findFirst.mockResolvedValue(null);
      await expect(service.reissueAndProvision('studio-1', 'user-1')).rejects.toThrow(ForbiddenException);
      expect(walletCredentials.reissue).not.toHaveBeenCalled();
    });
  });

  describe('getBarcode — in-app QR identity', () => {
    it('returns the same "gymos:v1:" barcode format used by Apple/Google, only when freshly issued', async () => {
      walletCredentials.issue.mockResolvedValue({ credential: { id: 'wc1' }, rawCredential: 'raw1' });
      prisma.walletPassArtifact.findUnique.mockResolvedValue(null);
      appleProvider.buildPkpass.mockResolvedValue(Buffer.from('pkpass'));
      prisma.walletPassArtifact.upsert.mockResolvedValue({ pkpassData: Buffer.from('pkpass') });
      googleProvider.ensureClassAndObject.mockResolvedValue({ objectId: 'obj1' });

      const result = await service.getBarcode('studio-1', 'user-1');

      expect(result).toEqual({ barcode: 'gymos:v1:raw1', isNew: true });
    });

    it('an existing credential with no recoverable artifact anywhere returns null, not a guess (the true unrecoverable case)', async () => {
      walletCredentials.issue.mockResolvedValue({
        credential: { id: 'wc1', studioId: 'studio-1', userId: 'user-1' },
        rawCredential: null,
      });
      prisma.walletPassArtifact.findUnique.mockResolvedValue(null);

      const result = await service.getBarcode('studio-1', 'user-1');

      expect(result).toEqual({ barcode: null, isNew: false });
      expect(appleProvider.buildPkpass).not.toHaveBeenCalled();
    });

    it('denies a member with no active StudioMembership before touching any credential', async () => {
      prisma.studioMembership.findFirst.mockResolvedValue(null);
      await expect(service.getBarcode('studio-1', 'user-1')).rejects.toThrow(ForbiddenException);
      expect(walletCredentials.issue).not.toHaveBeenCalled();
    });
  });

  describe('getBarcode — Phase 3.2 artifact-backed recovery', () => {
    const existingCredential = { id: 'wc1', studioId: 'studio-1', userId: 'user-1' };

    beforeEach(() => {
      walletCredentials.issue.mockResolvedValue({ credential: existingCredential, rawCredential: null });
    });

    it('recovers the barcode from an Apple artifact when no local raw value is available', async () => {
      const pkpass = await buildFixturePkpass('gymos:v1:recovered-raw');
      prisma.walletPassArtifact.findUnique.mockImplementation(
        async (args: { where: { walletCredentialId_platform: { platform: string } } }) =>
          args.where.walletCredentialId_platform.platform === 'APPLE' ? { pkpassData: pkpass } : null,
      );
      walletCredentials.resolve.mockResolvedValue({ status: 'active', credential: existingCredential });

      const result = await service.getBarcode('studio-1', 'user-1');

      expect(result.barcode).toBe('gymos:v1:recovered-raw');
      expect(result.isNew).toBe(false);
      expect(walletCredentials.resolve).toHaveBeenCalledWith('gymos:v1:recovered-raw');
    });

    it('recovers the barcode from an existing Google object when no Apple artifact exists', async () => {
      prisma.walletPassArtifact.findUnique.mockImplementation(
        async (args: { where: { walletCredentialId_platform: { platform: string } } }) =>
          args.where.walletCredentialId_platform.platform === 'GOOGLE' ? { googleObjectId: 'obj-1' } : null,
      );
      googleProvider.getExistingObjectBarcodeValue.mockResolvedValue('gymos:v1:recovered-raw');
      walletCredentials.resolve.mockResolvedValue({ status: 'active', credential: existingCredential });

      const result = await service.getBarcode('studio-1', 'user-1');

      expect(result.barcode).toBe('gymos:v1:recovered-raw');
      expect(googleProvider.getExistingObjectBarcodeValue).toHaveBeenCalledWith('obj-1');
    });

    it('does not call the Google API when Google is unconfigured, even if an artifact row exists', async () => {
      googleProvider.isConfigured.mockReturnValue(false);
      prisma.walletPassArtifact.findUnique.mockImplementation(
        async (args: { where: { walletCredentialId_platform: { platform: string } } }) =>
          args.where.walletCredentialId_platform.platform === 'GOOGLE' ? { googleObjectId: 'obj-1' } : null,
      );

      const result = await service.getBarcode('studio-1', 'user-1');

      expect(result.barcode).toBeNull();
      expect(googleProvider.getExistingObjectBarcodeValue).not.toHaveBeenCalled();
    });

    it('when Apple and Google both recover the same value, returns it without error', async () => {
      const pkpass = await buildFixturePkpass('gymos:v1:same-raw');
      prisma.walletPassArtifact.findUnique.mockImplementation(
        async (args: { where: { walletCredentialId_platform: { platform: string } } }) =>
          args.where.walletCredentialId_platform.platform === 'APPLE'
            ? { pkpassData: pkpass }
            : { googleObjectId: 'obj-1' },
      );
      googleProvider.getExistingObjectBarcodeValue.mockResolvedValue('gymos:v1:same-raw');
      walletCredentials.resolve.mockResolvedValue({ status: 'active', credential: existingCredential });

      const result = await service.getBarcode('studio-1', 'user-1');

      expect(result.barcode).toBe('gymos:v1:same-raw');
    });

    it('INTEGRITY: Apple and Google disagreeing on the recovered value is rejected outright, never arbitrarily resolved', async () => {
      const pkpass = await buildFixturePkpass('gymos:v1:apple-value');
      prisma.walletPassArtifact.findUnique.mockImplementation(
        async (args: { where: { walletCredentialId_platform: { platform: string } } }) =>
          args.where.walletCredentialId_platform.platform === 'APPLE'
            ? { pkpassData: pkpass }
            : { googleObjectId: 'obj-1' },
      );
      googleProvider.getExistingObjectBarcodeValue.mockResolvedValue('gymos:v1:google-value');
      walletCredentials.resolve.mockResolvedValue({ status: 'active', credential: existingCredential });

      await expect(service.getBarcode('studio-1', 'user-1')).rejects.toThrow('WALLET_RECOVERY_INTEGRITY_ERROR');
    });

    it('rejects a malformed Apple artifact (corrupt zip / missing barcode) instead of guessing', async () => {
      prisma.walletPassArtifact.findUnique.mockImplementation(
        async (args: { where: { walletCredentialId_platform: { platform: string } } }) =>
          args.where.walletCredentialId_platform.platform === 'APPLE' ? { pkpassData: Buffer.from('not a zip') } : null,
      );

      const result = await service.getBarcode('studio-1', 'user-1');

      expect(result.barcode).toBeNull();
    });

    it('rejects a recovered value that fails canonical format/hash resolution', async () => {
      const pkpass = await buildFixturePkpass('not-the-gymos-format');
      prisma.walletPassArtifact.findUnique.mockImplementation(
        async (args: { where: { walletCredentialId_platform: { platform: string } } }) =>
          args.where.walletCredentialId_platform.platform === 'APPLE' ? { pkpassData: pkpass } : null,
      );
      walletCredentials.resolve.mockResolvedValue({ status: 'invalid' });

      const result = await service.getBarcode('studio-1', 'user-1');

      expect(result.barcode).toBeNull();
    });

    it('rejects a recovered value whose resolved credential belongs to a DIFFERENT member (cross-member artifact mismatch)', async () => {
      const pkpass = await buildFixturePkpass('gymos:v1:someone-elses-raw');
      prisma.walletPassArtifact.findUnique.mockImplementation(
        async (args: { where: { walletCredentialId_platform: { platform: string } } }) =>
          args.where.walletCredentialId_platform.platform === 'APPLE' ? { pkpassData: pkpass } : null,
      );
      walletCredentials.resolve.mockResolvedValue({
        status: 'active',
        credential: { id: 'wc1', studioId: 'studio-1', userId: 'a-different-user' },
      });

      const result = await service.getBarcode('studio-1', 'user-1');

      expect(result.barcode).toBeNull();
    });

    it('rejects a recovered value whose resolved credential belongs to a DIFFERENT studio (cross-studio artifact mismatch)', async () => {
      const pkpass = await buildFixturePkpass('gymos:v1:wrong-studio-raw');
      prisma.walletPassArtifact.findUnique.mockImplementation(
        async (args: { where: { walletCredentialId_platform: { platform: string } } }) =>
          args.where.walletCredentialId_platform.platform === 'APPLE' ? { pkpassData: pkpass } : null,
      );
      walletCredentials.resolve.mockResolvedValue({
        status: 'active',
        credential: { id: 'wc1', studioId: 'a-different-studio', userId: 'user-1' },
      });

      const result = await service.getBarcode('studio-1', 'user-1');

      expect(result.barcode).toBeNull();
    });

    it('a REVOKED credential recovered from an artifact is never returned as valid', async () => {
      const pkpass = await buildFixturePkpass('gymos:v1:revoked-raw');
      prisma.walletPassArtifact.findUnique.mockImplementation(
        async (args: { where: { walletCredentialId_platform: { platform: string } } }) =>
          args.where.walletCredentialId_platform.platform === 'APPLE' ? { pkpassData: pkpass } : null,
      );
      walletCredentials.resolve.mockResolvedValue({ status: 'revoked', credential: existingCredential });

      const result = await service.getBarcode('studio-1', 'user-1');

      expect(result.barcode).toBeNull();
    });

    it('opportunistically backfills the missing platform after a successful recovery', async () => {
      const pkpass = await buildFixturePkpass('gymos:v1:backfill-raw');
      prisma.walletPassArtifact.findUnique.mockImplementation(
        async (args: { where: { walletCredentialId_platform: { platform: string } } }) =>
          args.where.walletCredentialId_platform.platform === 'APPLE' ? { pkpassData: pkpass } : null,
      );
      walletCredentials.resolve.mockResolvedValue({ status: 'active', credential: existingCredential });
      googleProvider.ensureClassAndObject.mockResolvedValue({ objectId: 'new-google-obj' });
      prisma.walletPassArtifact.upsert.mockResolvedValue({ googleObjectId: 'new-google-obj' });

      await service.getBarcode('studio-1', 'user-1');

      expect(googleProvider.ensureClassAndObject).toHaveBeenCalledWith(
        expect.objectContaining({ rawCredential: 'backfill-raw' }),
      );
    });

    it('no artifacts on either platform → explicit unrecoverable, no reissue attempted', async () => {
      prisma.walletPassArtifact.findUnique.mockResolvedValue(null);

      const result = await service.getBarcode('studio-1', 'user-1');

      expect(result).toEqual({ barcode: null, isNew: false });
      expect(walletCredentials.reissue).not.toHaveBeenCalled();
    });
  });

  describe('createAppleDownloadUrl / resolveAppleDownloadToken', () => {
    beforeEach(() => {
      walletCredentials.issue.mockResolvedValue({ credential: { id: 'wc1' }, rawCredential: 'raw1' });
      prisma.walletPassArtifact.findUnique.mockResolvedValue(null);
      appleProvider.buildPkpass.mockResolvedValue(Buffer.from('pkpass-bytes'));
      prisma.walletPassArtifact.upsert.mockResolvedValue({ pkpassData: Buffer.from('pkpass-bytes') });
      googleProvider.ensureClassAndObject.mockResolvedValue({ objectId: 'obj1' });
    });

    it('mints a URL under the given API base pointing at the download route', async () => {
      const url = await service.createAppleDownloadUrl('studio-1', 'user-1', 'https://api.example.com/api/v1');
      expect(url).toMatch(
        /^https:\/\/api\.example\.com\/api\/v1\/studios\/studio-1\/wallet\/apple\/download\/.+$/,
      );
    });

    it('the minted token resolves back to the exact provisioned pkpass bytes', async () => {
      const url = await service.createAppleDownloadUrl('studio-1', 'user-1', 'https://api.example.com/api/v1');
      const token = url.split('/').pop()!;
      prisma.walletPassArtifact.findUnique.mockResolvedValue({ pkpassData: Buffer.from('pkpass-bytes') });

      const bytes = await service.resolveAppleDownloadToken('studio-1', token);

      expect(bytes).toEqual(Buffer.from('pkpass-bytes'));
    });

    it('rejects a token scoped to a different studio than the one requested', async () => {
      const url = await service.createAppleDownloadUrl('studio-1', 'user-1', 'https://api.example.com/api/v1');
      const token = url.split('/').pop()!;
      await expect(service.resolveAppleDownloadToken('studio-2', token)).rejects.toThrow(
        'WALLET_DOWNLOAD_TOKEN_INVALID',
      );
    });

    it('rejects a malformed/garbage token', async () => {
      await expect(service.resolveAppleDownloadToken('studio-1', 'not-a-real-token')).rejects.toThrow(
        'WALLET_DOWNLOAD_TOKEN_INVALID',
      );
    });

    it('rejects a well-formed but expired token', async () => {
      const expired = jwt.sign(
        { sub: 'user-1', studioId: 'studio-1', walletCredentialId: 'wc1', purpose: 'apple-pkpass-download' },
        'test-jwt-qr-secret-min-32-chars!!',
        { algorithm: 'HS256', expiresIn: -10 },
      );
      await expect(service.resolveAppleDownloadToken('studio-1', expired)).rejects.toThrow(
        'WALLET_DOWNLOAD_TOKEN_INVALID',
      );
    });
  });

  describe('artifact lookup', () => {
    it('looks up the artifact scoped to both the credential and the specific platform', async () => {
      walletCredentials.issue.mockResolvedValue({ credential: { id: 'wc1' }, rawCredential: null });
      prisma.walletPassArtifact.findUnique.mockResolvedValue({ pkpassData: Buffer.from('x') });
      await service.getApplePass('studio-1', 'user-1');
      expect(prisma.walletPassArtifact.findUnique).toHaveBeenCalledWith({
        where: { walletCredentialId_platform: { walletCredentialId: 'wc1', platform: WalletPassPlatform.APPLE } },
      });
    });
  });
});
