// Must stay the first import: sets the Smart Wallet env (all flags OFF) before AppModule is imported.
import './helpers/wallet-dynamic-env.off';
import type { INestApplication } from '@nestjs/common';
import { Role, WalletPassMode, WalletPassPlatform } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { hashPassAuthenticationToken } from '../src/wallet/apple/passkit-token';
import { extractPassJsonFromPkpass } from '../src/wallet/apple/pkpass-reader';
import { WalletDynamicPassError, WalletDynamicPassService } from '../src/wallet/dynamic/wallet-dynamic-pass.service';
import { WalletPassPushError, WalletPassPushService } from '../src/wallet/passkit/wallet-pass-push.service';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import { createMembership, createStudio, createUserWithPassword } from './helpers/factories';
import { appleFixture, DYNAMIC_PASS_TYPE } from './helpers/wallet-dynamic-env';

/** supertest does not buffer application/vnd.apple.pkpass by itself; collect the raw bytes. */
function binaryParser(res: request.Response, callback: (err: Error | null, body: Buffer) => void): void {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  stream.on('end', () => callback(null, Buffer.concat(chunks)));
}

const maybeDescribe = appleFixture ? describe : describe.skip;

/** Default production posture: every Smart Wallet flag OFF. */
maybeDescribe('Smart Wallet 2.0 with all flags OFF (e2e)', () => {
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

  async function memberWithStaticPass() {
    const studio = await createStudio(prisma, { timezone: 'America/Mexico_City' });
    const member = await createUserWithPassword(prisma, { email: 'flags-off@e2e.local' });
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: member.email, password: member.password }).expect(201);
    const jwt = (login.body as { accessToken: string }).accessToken;
    const download = () =>
      request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/wallet/apple`)
        .set('Authorization', `Bearer ${jwt}`)
        .buffer(true)
        .parse(binaryParser)
        .expect(200)
        .then((r) => r.body as Buffer);
    const pkpass = await download();
    const serial = ((await extractPassJsonFromPkpass(pkpass)) as { serialNumber: string }).serialNumber;
    return { studio, member, jwt, serial, pkpass, download };
  }

  it('every PassKit route is a plain 404, with or without a token', async () => {
    const auth = `ApplePass ${'a'.repeat(43)}`;
    const base = '/api/v1/wallet/passkit/v1';
    const server = app.getHttpServer();
    await request(server).post(`${base}/devices/dev1/registrations/${DYNAMIC_PASS_TYPE}/serial1`).set('Authorization', auth).send({ pushToken: 'ab'.repeat(32) }).expect(404);
    await request(server).get(`${base}/devices/dev1/registrations/${DYNAMIC_PASS_TYPE}`).expect(404);
    await request(server).delete(`${base}/devices/dev1/registrations/${DYNAMIC_PASS_TYPE}/serial1`).set('Authorization', auth).expect(404);
    await request(server).get(`${base}/passes/${DYNAMIC_PASS_TYPE}/serial1`).set('Authorization', auth).expect(404);
    await request(server).post(`${base}/log`).send({ logs: ['x'] }).expect(404);
  });

  it('the existing static pass flow is unchanged: STATIC artifact, no token, no web service', async () => {
    const m = await memberWithStaticPass();
    const artifact = await prisma.walletPassArtifact.findUniqueOrThrow({
      where: { walletCredentialId_platform: { walletCredentialId: m.serial, platform: WalletPassPlatform.APPLE } },
    });
    expect(artifact).toMatchObject({
      passMode: WalletPassMode.STATIC,
      passVersion: 0,
      templateVersion: 2,
      authenticationTokenHash: null,
      contentHash: null,
      lastModifiedAt: null,
      dynamicTemplateVersion: null,
      dynamicEnabledAt: null,
    });
    const passJson = await extractPassJsonFromPkpass(m.pkpass);
    expect(passJson).not.toHaveProperty('webServiceURL');
    expect(passJson).not.toHaveProperty('authenticationToken');
  });

  it('enrollment and pushes refuse; the read-only preview still works', async () => {
    const m = await memberWithStaticPass();
    const dynamic = app.get(WalletDynamicPassService);
    await expect(dynamic.enroll(m.serial)).rejects.toMatchObject({ code: 'WALLET_DYNAMIC_DISABLED' });
    await expect(dynamic.refresh(m.serial)).rejects.toBeInstanceOf(WalletDynamicPassError);
    await expect(app.get(WalletPassPushService).pushPassUpdate(m.serial)).rejects.toBeInstanceOf(WalletPassPushError);
    await expect(app.get(WalletPassPushService).pushPassUpdate(m.serial)).rejects.toMatchObject({ code: 'WALLET_APNS_DISABLED' });
    await expect(dynamic.preview(m.serial)).resolves.toMatchObject({ passMode: WalletPassMode.STATIC, snapshot: { overall: 'NO_MEMBERSHIP' } });
  });

  it('rollback safety: a DYNAMIC artifact left behind when flags go off is still served as stored, never rebuilt', async () => {
    const m = await memberWithStaticPass();
    const row = await prisma.walletPassArtifact.findUniqueOrThrow({
      where: { walletCredentialId_platform: { walletCredentialId: m.serial, platform: WalletPassPlatform.APPLE } },
    });
    const now = new Date();
    const dynamicRow = await prisma.walletPassArtifact.update({
      where: { id: row.id },
      data: {
        passMode: WalletPassMode.DYNAMIC,
        templateVersion: null, // would be "stale" to the static path if it were STATIC
        dynamicTemplateVersion: 1,
        authenticationTokenHash: hashPassAuthenticationToken('t'.repeat(43)),
        contentHash: '0'.repeat(64),
        passVersion: 1,
        lastModifiedAt: now,
        dynamicEnabledAt: now,
      },
    });

    const served = await m.download();
    expect(served.equals(Buffer.from(dynamicRow.pkpassData!))).toBe(true);
    const after = await prisma.walletPassArtifact.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.updatedAt).toEqual(dynamicRow.updatedAt);
    expect(after.passMode).toBe(WalletPassMode.DYNAMIC);
  });
});
