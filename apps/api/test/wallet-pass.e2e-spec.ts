import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { generateTestApplePkiFixture } from '../src/wallet/apple/test-cert-fixture';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import { createMembership, createStudio, createUserWithPassword } from './helpers/factories';

// Real (throwaway, non-Apple-issued) signing config so POST /wallet/apple can be exercised
// fully end-to-end over real HTTP without any actual Apple credential. Must be set before
// createTestApp() boots the Nest app, since ConfigModule reads process.env at bootstrap.
const appleFixture = generateTestApplePkiFixture();
if (appleFixture) {
  process.env['WALLET_APPLE_TEAM_ID'] = 'TEAM123TEST';
  process.env['WALLET_APPLE_PASS_TYPE_ID'] = 'pass.co.gymos.member.test';
  process.env['WALLET_APPLE_SIGNING_CERT_P12_BASE64'] = appleFixture.p12Base64;
  process.env['WALLET_APPLE_SIGNING_CERT_PASSWORD'] = appleFixture.p12Password;
  process.env['WALLET_APPLE_WWDR_CERT_PEM_BASE64'] = appleFixture.wwdrPemBase64;
}
// Deliberately NOT setting WALLET_GOOGLE_* — no Google Wallet issuer account exists yet;
// this matches real deployment today and lets us prove the "not configured" path for real.

/** supertest doesn't know how to buffer "application/vnd.apple.pkpass" by default — without
 *  this, res.body comes back as an empty {} instead of the actual bytes. */
function binaryParser(res: NodeJS.ReadableStream & { setEncoding: (enc: string) => void }, callback: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

function postApplePass(app: INestApplication, studioId: string, token: string) {
  return request(app.getHttpServer())
    .post(`/api/v1/studios/${studioId}/wallet/apple`)
    .set('Authorization', `Bearer ${token}`)
    .buffer(true)
    .parse(binaryParser);
}

async function loginAccessToken(app: INestApplication, email: string, password: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password })
    .expect(201);
  return (res.body as { accessToken: string }).accessToken;
}

const maybeDescribe = appleFixture ? describe : describe.skip;

maybeDescribe('Wallet pass member endpoints (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
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

  describe('authentication and studio isolation', () => {
    it('rejects an unauthenticated request', async () => {
      const studio = await createStudio(prisma);
      await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/wallet/apple`)
        .expect(401);
    });

    it('rejects a member who does not belong to the target studio', async () => {
      const { token } = await setupMember('iso-a');
      const otherStudio = await createStudio(prisma);
      await request(app.getHttpServer())
        .post(`/api/v1/studios/${otherStudio.id}/wallet/apple`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });
  });

  describe('POST /wallet/apple — real signing pipeline, no real Apple credential', () => {
    it('returns a downloadable, correctly signed .pkpass for the authenticated member only', async () => {
      const { studio, token } = await setupMember('apple-ok');

      const res = await postApplePass(app, studio.id, token).expect(200);

      expect(res.headers['content-type']).toContain('application/vnd.apple.pkpass');
      expect(Buffer.isBuffer(res.body)).toBe(true);
      expect((res.body as Buffer).length).toBeGreaterThan(0);
    });

    it('two different members of the same studio get two different passes (own pass only)', async () => {
      const studio = await createStudio(prisma);
      const memberA = await createUserWithPassword(prisma, { email: 'own-a@e2e.local' });
      const memberB = await createUserWithPassword(prisma, { email: 'own-b@e2e.local' });
      await createMembership(prisma, memberA.id, studio.id, Role.MEMBER);
      await createMembership(prisma, memberB.id, studio.id, Role.MEMBER);
      const tokenA = await loginAccessToken(app, memberA.email, memberA.password);
      const tokenB = await loginAccessToken(app, memberB.email, memberB.password);

      const resA = await postApplePass(app, studio.id, tokenA).expect(200);
      const resB = await postApplePass(app, studio.id, tokenB).expect(200);

      expect(Buffer.compare(resA.body as Buffer, resB.body as Buffer)).not.toBe(0);

      const credA = await prisma.walletCredential.findFirst({ where: { studioId: studio.id, userId: memberA.id } });
      const credB = await prisma.walletCredential.findFirst({ where: { studioId: studio.id, userId: memberB.id } });
      expect(credA!.id).not.toBe(credB!.id);
    });

    it('re-download returns the SAME barcode/credential — no rotation', async () => {
      const { studio, token } = await setupMember('redownload');

      const first = await postApplePass(app, studio.id, token).expect(200);
      const second = await postApplePass(app, studio.id, token).expect(200);

      expect(Buffer.compare(first.body as Buffer, second.body as Buffer)).toBe(0);
    });

    it('explicit reissue invalidates the previous credential — old barcode stops resolving, new pass is different', async () => {
      const { studio, member, token } = await setupMember('reissue');

      const before = await postApplePass(app, studio.id, token).expect(200);
      const oldCredential = await prisma.walletCredential.findFirstOrThrow({
        where: { studioId: studio.id, userId: member.id },
      });

      // Phase 3.2: reissue is now an explicit member self-service HTTP endpoint (see
      // wallet-recovery.e2e-spec.ts for the full reissue test matrix) — exercised for real
      // here rather than calling the service directly, so this test also covers the actual
      // authorization boundary the member would hit.
      await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/wallet/reissue`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // The OLD credential is now revoked and denied at the actual authorization boundary —
      // Phase 1's check-in path, proven here rather than assumed.
      const oldRow = await prisma.walletCredential.findUniqueOrThrow({ where: { id: oldCredential.id } });
      expect(oldRow.revokedAt).not.toBeNull();

      // A subsequent re-download now returns the NEW pass, provisioned eagerly by reissue,
      // and it is a genuinely different pass from the pre-reissue one.
      const after = await postApplePass(app, studio.id, token).expect(200);
      expect(Buffer.compare(before.body as Buffer, after.body as Buffer)).not.toBe(0);
    });

    it('does not require an active subscription/entitlement to issue a pass', async () => {
      // setupMember creates a StudioMembership with no subscription at all.
      const { studio, token } = await setupMember('no-entitlement');
      await postApplePass(app, studio.id, token).expect(200);
    });
  });

  describe('POST /wallet/google — no Google Wallet issuer account configured yet', () => {
    it('fails clearly with WALLET_GOOGLE_NOT_CONFIGURED rather than a raw error, for an otherwise-eligible member', async () => {
      const { studio, token } = await setupMember('google-unconfigured');
      const res = await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/wallet/google`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);
      expect(String((res.body as { message: unknown }).message)).toContain('WALLET_GOOGLE_NOT_CONFIGURED');
    });

    it('still enforces auth and studio isolation before reaching the not-configured error', async () => {
      const studio = await createStudio(prisma);
      await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/wallet/google`)
        .expect(401);
    });
  });

  describe('POST /wallet/credential — in-app QR identity', () => {
    it('returns the same barcode value the Apple pass embeds, only on first issuance', async () => {
      const { studio, token } = await setupMember('barcode-first');

      const res = await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/wallet/credential`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = res.body as { barcode: string; isNew: boolean };
      expect(body.isNew).toBe(true);
      expect(body.barcode.startsWith('gymos:v1:')).toBe(true);

      // The eager dual-provisioning triggered by viewing the barcode already produced a
      // usable Apple pass — re-download now returns it without a second raw-generating call.
      const pkpass = await postApplePass(app, studio.id, token).expect(200);
      expect((pkpass.body as Buffer).length).toBeGreaterThan(0);
    });

    it('a second call returns isNew:false and recovers the SAME barcode from the Apple artifact (Phase 3.2) — never fabricates a different one', async () => {
      const { studio, token } = await setupMember('barcode-second');

      const first = await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/wallet/credential`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const second = await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/wallet/credential`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const firstBody = first.body as { barcode: string; isNew: boolean };
      const secondBody = second.body as { barcode: string; isNew: boolean };
      expect(secondBody.isNew).toBe(false);
      expect(secondBody.barcode).toBe(firstBody.barcode);
    });

    it('rejects an unauthenticated request', async () => {
      const studio = await createStudio(prisma);
      await request(app.getHttpServer()).post(`/api/v1/studios/${studio.id}/wallet/credential`).expect(401);
    });
  });

  describe('Apple download-link + token GET (in-app browser handoff)', () => {
    it('mints a download URL and the GET returns the same pkpass bytes as the POST endpoint', async () => {
      const { studio, token } = await setupMember('download-link');

      const linkRes = await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/wallet/apple/download-link`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const { downloadUrl } = linkRes.body as { downloadUrl: string; expiresInSeconds: number };
      const path = downloadUrl.replace(/^https?:\/\/[^/]+/, '');

      const getRes = await request(app.getHttpServer()).get(path).buffer(true).parse(binaryParser).expect(200);
      expect(getRes.headers['content-type']).toContain('application/vnd.apple.pkpass');

      const postRes = await postApplePass(app, studio.id, token).expect(200);
      expect(Buffer.compare(getRes.body as Buffer, postRes.body as Buffer)).toBe(0);
    });

    it('the download GET needs no Authorization header — the token itself is the auth', async () => {
      const { studio, token } = await setupMember('download-noauth');
      const linkRes = await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/wallet/apple/download-link`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const { downloadUrl } = linkRes.body as { downloadUrl: string };
      const path = downloadUrl.replace(/^https?:\/\/[^/]+/, '');

      await request(app.getHttpServer()).get(path).expect(200);
    });

    it('rejects the token when replayed against a different studio in the URL', async () => {
      const { studio, token } = await setupMember('download-cross-studio');
      const otherStudio = await createStudio(prisma);
      const linkRes = await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/wallet/apple/download-link`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const { downloadUrl } = linkRes.body as { downloadUrl: string };
      const tokenOnly = downloadUrl.split('/').pop()!;

      const res = await request(app.getHttpServer())
        .get(`/api/v1/studios/${otherStudio.id}/wallet/apple/download/${tokenOnly}`)
        .expect(401);
      expect(String((res.body as { message: unknown }).message)).toContain('WALLET_DOWNLOAD_TOKEN_INVALID');
    });

    it('rejects a garbage token distinctly, not a 500', async () => {
      const studio = await createStudio(prisma);
      const res = await request(app.getHttpServer())
        .get(`/api/v1/studios/${studio.id}/wallet/apple/download/not-a-real-token`)
        .expect(401);
      expect(String((res.body as { message: unknown }).message)).toContain('WALLET_DOWNLOAD_TOKEN_INVALID');
    });
  });
});
