import { WalletCredentialService } from './wallet-credential.service';
import { WALLET_CREDENTIAL_PREFIX, hashWalletCredential } from './wallet-credential.constants';

describe('WalletCredentialService', () => {
  const prisma = {
    walletCredential: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    $executeRaw: jest.fn().mockResolvedValue(undefined),
    $transaction: jest.fn(),
  };

  const service = new WalletCredentialService(prisma as never);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));
  });

  describe('issue', () => {
    it('creates a new credential when none is active, and returns the raw value exactly once', async () => {
      prisma.walletCredential.findFirst.mockResolvedValue(null);
      prisma.walletCredential.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'wc1', ...data, revokedAt: null }),
      );

      const result = await service.issue('studio-1', 'user-1');

      expect(result.created).toBe(true);
      expect(result.rawCredential).not.toBeNull();
      expect(result.rawCredential!.length).toBeGreaterThanOrEqual(32);
      expect(prisma.walletCredential.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            studioId: 'studio-1',
            userId: 'user-1',
            credentialHash: hashWalletCredential(result.rawCredential!),
          }),
        }),
      );
    });

    it('reuses the existing active credential row and returns no raw value (idempotent at the row level only)', async () => {
      const existing = { id: 'wc1', studioId: 'studio-1', userId: 'user-1', credentialHash: 'h', revokedAt: null };
      prisma.walletCredential.findFirst.mockResolvedValue(existing);

      const result = await service.issue('studio-1', 'user-1');

      expect(result.created).toBe(false);
      expect(result.credential).toBe(existing);
      expect(result.rawCredential).toBeNull();
      expect(prisma.walletCredential.create).not.toHaveBeenCalled();
    });

    it('recovers gracefully from a racing unique-constraint violation instead of throwing', async () => {
      prisma.walletCredential.findFirst
        .mockResolvedValueOnce(null) // inside the (lost) race
        .mockResolvedValueOnce({ id: 'winner', studioId: 'studio-1', userId: 'user-1', credentialHash: 'h', revokedAt: null });
      prisma.walletCredential.create.mockRejectedValue(
        Object.assign(new Error('unique violation'), { code: 'P2002' }),
      );

      const result = await service.issue('studio-1', 'user-1');

      expect(result.created).toBe(false);
      expect(result.credential.id).toBe('winner');
      expect(result.rawCredential).toBeNull();
    });
  });

  describe('reissue', () => {
    it('revokes the old active credential and creates a new one atomically', async () => {
      prisma.walletCredential.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'wc2', ...data, revokedAt: null }),
      );

      const result = await service.reissue('studio-1', 'user-1');

      expect(prisma.walletCredential.updateMany).toHaveBeenCalledWith({
        where: { studioId: 'studio-1', userId: 'user-1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(result.rawCredential).toBeDefined();
      expect(prisma.walletCredential.create).toHaveBeenCalled();
    });
  });

  describe('resolve', () => {
    it('rejects a barcode with the wrong/missing prefix', async () => {
      const res = await service.resolve('not-a-wallet-credential');
      expect(res).toEqual({ status: 'invalid' });
      expect(prisma.walletCredential.findUnique).not.toHaveBeenCalled();
    });

    it('rejects a short/malformed raw value without a DB lookup', async () => {
      const res = await service.resolve(`${WALLET_CREDENTIAL_PREFIX}short`);
      expect(res).toEqual({ status: 'invalid' });
      expect(prisma.walletCredential.findUnique).not.toHaveBeenCalled();
    });

    it('rejects an unknown (never-issued) credential', async () => {
      prisma.walletCredential.findUnique.mockResolvedValue(null);
      const raw = 'a'.repeat(40);
      const res = await service.resolve(`${WALLET_CREDENTIAL_PREFIX}${raw}`);
      expect(res).toEqual({ status: 'invalid' });
      expect(prisma.walletCredential.findUnique).toHaveBeenCalledWith({
        where: { credentialHash: hashWalletCredential(raw) },
      });
    });

    it('resolves an active credential', async () => {
      const raw = 'b'.repeat(40);
      const credential = { id: 'wc1', studioId: 's1', userId: 'u1', credentialHash: hashWalletCredential(raw), revokedAt: null };
      prisma.walletCredential.findUnique.mockResolvedValue(credential);
      const res = await service.resolve(`${WALLET_CREDENTIAL_PREFIX}${raw}`);
      expect(res).toEqual({ status: 'active', credential });
    });

    it('distinguishes a revoked credential from an unknown one', async () => {
      const raw = 'c'.repeat(40);
      const credential = { id: 'wc1', studioId: 's1', userId: 'u1', credentialHash: hashWalletCredential(raw), revokedAt: new Date() };
      prisma.walletCredential.findUnique.mockResolvedValue(credential);
      const res = await service.resolve(`${WALLET_CREDENTIAL_PREFIX}${raw}`);
      expect(res).toEqual({ status: 'revoked', credential });
    });

    it('never derives the hash from the full barcode value (prefix must be stripped first)', async () => {
      const raw = 'd'.repeat(40);
      prisma.walletCredential.findUnique.mockResolvedValue(null);
      const barcode = `${WALLET_CREDENTIAL_PREFIX}${raw}`;
      await service.resolve(barcode);
      expect(prisma.walletCredential.findUnique).toHaveBeenCalledWith({
        where: { credentialHash: hashWalletCredential(raw) },
      });
      expect(prisma.walletCredential.findUnique).not.toHaveBeenCalledWith({
        where: { credentialHash: hashWalletCredential(barcode) },
      });
    });
  });

  describe('revoke / revokeById', () => {
    it('revoke() only updates the currently active row', async () => {
      prisma.walletCredential.updateMany.mockResolvedValue({ count: 1 });
      await service.revoke('studio-1', 'user-1');
      expect(prisma.walletCredential.updateMany).toHaveBeenCalledWith({
        where: { studioId: 'studio-1', userId: 'user-1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('revokeById() is a no-op (count 0) when the credential is already revoked', async () => {
      prisma.walletCredential.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.revokeById('wc1')).resolves.toBeUndefined();
    });
  });
});
