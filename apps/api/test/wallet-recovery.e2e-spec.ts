import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { generateTestApplePkiFixture } from '../src/wallet/apple/test-cert-fixture';
import { WalletCredentialService } from '../src/wallet/wallet-credential.service';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import { createMembership, createStudio, createUserWithPassword } from './helpers/factories';

/**
 * PHASE 3.2 — artifact-backed recovery, multi-device behavior, and explicit reissue, all
 * exercised over real HTTP against the real Apple signing pipeline (throwaway test cert,
 * same fixture wallet-pass.e2e-spec.ts uses). Google's REST calls are unit-tested only
 * (mocked fetchImpl) — the existing convention in this codebase, since no e2e file anywhere
 * exercises real Google Wallet HTTP calls (only its NOT_CONFIGURED path is e2e-tested).
 */
const appleFixture = generateTestApplePkiFixture();
if (appleFixture) {
  process.env['WALLET_APPLE_TEAM_ID'] = 'TEAM123TEST';
  process.env['WALLET_APPLE_PASS_TYPE_ID'] = 'pass.co.gymos.member.test';
  process.env['WALLET_APPLE_SIGNING_CERT_P12_BASE64'] = appleFixture.p12Base64;
  process.env['WALLET_APPLE_SIGNING_CERT_PASSWORD'] = appleFixture.p12Password;
  process.env['WALLET_APPLE_WWDR_CERT_PEM_BASE64'] = appleFixture.wwdrPemBase64;
}

async function loginAccessToken(app: INestApplication, email: string, password: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password })
    .expect(201);
  return (res.body as { accessToken: string }).accessToken;
}

function postCredential(app: INestApplication, studioId: string, token: string) {
  return request(app.getHttpServer())
    .post(`/api/v1/studios/${studioId}/wallet/credential`)
    .set('Authorization', `Bearer ${token}`);
}

function postReissue(app: INestApplication, studioId: string, token: string) {
  return request(app.getHttpServer())
    .post(`/api/v1/studios/${studioId}/wallet/reissue`)
    .set('Authorization', `Bearer ${token}`);
}

const maybeDescribe = appleFixture ? describe : describe.skip;

maybeDescribe('Wallet credential recovery + explicit reissue (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let walletCredentials: WalletCredentialService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    walletCredentials = app.get(WalletCredentialService);
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  async function setupMember(prefix: string) {
    const studio = await createStudio(prisma);
    const member = await createUserWithPassword(prisma, { email: `${prefix}-mem@e2e.local` });
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    const token = await loginAccessToken(app, member.email, member.password);
    return { studio, member, token };
  }

  describe('same-device behavior', () => {
    it('repeat calls after initial issuance return the SAME barcode via recovery, not null', async () => {
      const { studio, token } = await setupMember('same-device');

      const first = await postCredential(app, studio.id, token).expect(200);
      const second = await postCredential(app, studio.id, token).expect(200);

      const firstBody = first.body as { barcode: string; isNew: boolean };
      const secondBody = second.body as { barcode: string | null; isNew: boolean };
      expect(firstBody.isNew).toBe(true);
      expect(secondBody.isNew).toBe(false);
      expect(secondBody.barcode).toBe(firstBody.barcode);
    });
  });

  describe('multi-device recovery (Part B)', () => {
    it('device B recovers the SAME credential device A already has, without rotating it', async () => {
      const { studio, member, token } = await setupMember('multi-device');

      // Device A: first-ever issuance, provisions the Apple artifact.
      const deviceA = await postCredential(app, studio.id, token).expect(200);
      const deviceABarcode = (deviceA.body as { barcode: string }).barcode;

      // Device B: same member, same studio, brand-new session — never received raw locally.
      // This call has no local cache; the backend must recover, not reissue.
      const deviceB = await postCredential(app, studio.id, token).expect(200);
      const deviceBBarcode = (deviceB.body as { barcode: string | null }).barcode;

      expect(deviceBBarcode).toBe(deviceABarcode);

      // Device A reopens afterward — still the same credential, still valid, never rotated.
      const deviceAAgain = await postCredential(app, studio.id, token).expect(200);
      expect((deviceAAgain.body as { barcode: string }).barcode).toBe(deviceABarcode);

      // Exactly one active WalletCredential row exists throughout — no silent duplicate issuance.
      const activeCount = await prisma.walletCredential.count({
        where: { studioId: studio.id, userId: member.id, revokedAt: null },
      });
      expect(activeCount).toBe(1);
    });
  });

  describe('reinstall / SecureStore loss (Part C)', () => {
    it('credential + artifact exist, local cache is gone — loads the SAME credential, no rotation, no duplicate artifact', async () => {
      const { studio, token } = await setupMember('reinstall');

      const before = await postCredential(app, studio.id, token).expect(200);
      const beforeBarcode = (before.body as { barcode: string }).barcode;
      const beforeCredential = await prisma.walletCredential.findFirstOrThrow({ where: { studioId: studio.id } });
      const beforeArtifactCount = await prisma.walletPassArtifact.count({
        where: { walletCredentialId: beforeCredential.id },
      });

      // Simulate app reinstall: identical request, zero local state, only the JWT survives.
      const after = await postCredential(app, studio.id, token).expect(200);
      const afterBarcode = (after.body as { barcode: string | null }).barcode;
      const afterCredential = await prisma.walletCredential.findFirstOrThrow({ where: { studioId: studio.id } });
      const afterArtifactCount = await prisma.walletPassArtifact.count({
        where: { walletCredentialId: afterCredential.id },
      });

      expect(afterBarcode).toBe(beforeBarcode);
      expect(afterCredential.id).toBe(beforeCredential.id);
      expect(afterCredential.revokedAt).toBeNull();
      expect(afterArtifactCount).toBe(beforeArtifactCount);
    });
  });

  describe('true unrecoverable case (Part D)', () => {
    it('credential exists, raw already consumed, no artifact on either platform → explicit null, never silently reissued', async () => {
      const { studio, member, token } = await setupMember('unrecoverable');

      // Reissue directly at the service level to land on a BRAND NEW credential row with
      // zero artifacts — nothing has ever been provisioned for it, and its raw value is
      // "lost" the moment this call returns (never captured by any client).
      await walletCredentials.reissue(studio.id, member.id);

      const res = await postCredential(app, studio.id, token).expect(200);
      const body = res.body as { barcode: string | null; isNew: boolean };

      expect(body.barcode).toBeNull();
      expect(body.isNew).toBe(false);

      // Confirms this is genuinely a "nothing to recover" case, not a masked error.
      const credential = await prisma.walletCredential.findFirstOrThrow({
        where: { studioId: studio.id, userId: member.id, revokedAt: null },
      });
      const artifactCount = await prisma.walletPassArtifact.count({ where: { walletCredentialId: credential.id } });
      expect(artifactCount).toBe(0);
    });
  });

  describe('explicit reissue (Part E)', () => {
    it('a member can reissue their own credential and immediately gets a new working barcode', async () => {
      const { studio, token } = await setupMember('reissue-self');
      await postCredential(app, studio.id, token).expect(200);

      const res = await postReissue(app, studio.id, token).expect(200);
      const body = res.body as { barcode: string; applePkpassAvailable: boolean; googleWalletAvailable: boolean };

      expect(typeof body.barcode).toBe('string');
      expect(body.barcode).toMatch(/^gymos:v1:/);
      expect(body.applePkpassAvailable).toBe(true);
    });

    it('the OLD barcode is rejected by check-in scanning after reissue', async () => {
      const { studio, token } = await setupMember('reissue-old-rejected');
      const staffUser = await createUserWithPassword(prisma, { email: 'reissue-staff@e2e.local' });
      await createMembership(prisma, staffUser.id, studio.id, Role.STAFF);
      const staffToken = await loginAccessToken(app, staffUser.email, staffUser.password);

      const first = await postCredential(app, studio.id, token).expect(200);
      const oldBarcode = (first.body as { barcode: string }).barcode;

      await postReissue(app, studio.id, token).expect(200);

      const scanRes = await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/check-ins/qr`)
        .set('Authorization', `Bearer ${staffToken}`)
        .send({ qrToken: oldBarcode })
        .expect(401);
      expect(String((scanRes.body as { message: unknown }).message)).toContain('WALLET_CREDENTIAL_REVOKED');
    });

    it('the NEW barcode after reissue is accepted for recovery on a subsequent call', async () => {
      const { studio, token } = await setupMember('reissue-new-accepted');
      await postCredential(app, studio.id, token).expect(200);

      const reissueRes = await postReissue(app, studio.id, token).expect(200);
      const newBarcode = (reissueRes.body as { barcode: string }).barcode;

      const recovered = await postCredential(app, studio.id, token).expect(200);
      expect((recovered.body as { barcode: string }).barcode).toBe(newBarcode);
    });

    it('only ONE active credential exists after reissue — the old row is revoked, not deleted or duplicated', async () => {
      const { studio, member, token } = await setupMember('reissue-single-active');
      await postCredential(app, studio.id, token).expect(200);
      await postReissue(app, studio.id, token).expect(200);

      const active = await prisma.walletCredential.findMany({
        where: { studioId: studio.id, userId: member.id, revokedAt: null },
      });
      const all = await prisma.walletCredential.findMany({ where: { studioId: studio.id, userId: member.id } });
      expect(active).toHaveLength(1);
      expect(all).toHaveLength(2);
      expect(all.some((c) => c.revokedAt !== null)).toBe(true);
    });

    it('a Google provisioning failure (unconfigured in this test env) does not prevent reissue from succeeding', async () => {
      const { studio, token } = await setupMember('reissue-google-unconfigured');
      const res = await postReissue(app, studio.id, token).expect(200);
      const body = res.body as { barcode: string; googleWalletAvailable: boolean };
      expect(typeof body.barcode).toBe('string');
      expect(body.googleWalletAvailable).toBe(false);
    });

    it('denies reissue for an unauthenticated request', async () => {
      const studio = await createStudio(prisma);
      await request(app.getHttpServer()).post(`/api/v1/studios/${studio.id}/wallet/reissue`).expect(401);
    });

    it('denies reissue for a member outside the target studio (cross-studio)', async () => {
      const { token } = await setupMember('reissue-cross-studio');
      const otherStudio = await createStudio(prisma);
      await postReissue(app, otherStudio.id, token).expect(403);
    });

    it('cross-member isolation: member A reissuing never touches member B\'s credential', async () => {
      const { studio, token: tokenA } = await setupMember('reissue-cross-a');
      const memberB = await createUserWithPassword(prisma, { email: 'reissue-cross-b@e2e.local' });
      await createMembership(prisma, memberB.id, studio.id, Role.MEMBER);
      const tokenB = await loginAccessToken(app, memberB.email, memberB.password);

      await postCredential(app, studio.id, tokenB).expect(200);
      const bCredentialBefore = await prisma.walletCredential.findFirstOrThrow({
        where: { studioId: studio.id, userId: memberB.id },
      });

      await postCredential(app, studio.id, tokenA).expect(200);
      await postReissue(app, studio.id, tokenA).expect(200);

      const bCredentialAfter = await prisma.walletCredential.findFirstOrThrow({
        where: { studioId: studio.id, userId: memberB.id },
      });
      expect(bCredentialAfter.id).toBe(bCredentialBefore.id);
      expect(bCredentialAfter.revokedAt).toBeNull();
    });
  });

  describe('no raw credential leakage (Part G)', () => {
    it('the reissue response body never includes the OLD barcode value', async () => {
      const { studio, token } = await setupMember('no-leak');
      const first = await postCredential(app, studio.id, token).expect(200);
      const oldBarcode = (first.body as { barcode: string }).barcode;

      const res = await postReissue(app, studio.id, token).expect(200);
      expect(JSON.stringify(res.body)).not.toContain(oldBarcode);
    });
  });
});
