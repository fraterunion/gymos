// Must be the FIRST import: sets isolated, synthetic signing and Stage 4B flags.
import './helpers/wallet-stage4b-env.on';
import type { INestApplication } from '@nestjs/common';
import { Role, WalletPassMode, WalletPassPlatform } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { APPLE_PASS_TEMPLATE_VERSION } from '../src/wallet/apple/apple-wallet.constants';
import { extractPassJsonFromPkpass } from '../src/wallet/apple/pkpass-reader';
import { verifyPassAuthenticationToken } from '../src/wallet/apple/passkit-token';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import { createMembership, createStudio } from './helpers/factories';
import { appleFixture, DYNAMIC_PASS_TYPE, DYNAMIC_WEB_SERVICE_URL } from './helpers/wallet-dynamic-env';

/**
 * Stage 4B: real HTTP -> real PostgreSQL -> synthetic-signed PassKit flow.
 * No user data or live Apple account; APNs and the refresh worker are OFF.
 */
const STUDIO_ID = 'stage4b-test-studio';
const ALLOWED_ID = 'stage4b-allowed-user';
const OUTSIDE_ID = 'stage4b-outside-user';
const PASSKIT = '/api/v1/wallet/passkit/v1';
const DEVICE = 'device-stage4b-synthetic-01';
const PUSH = 'ab'.repeat(32);

function binaryParser(res: request.Response, done: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  (res as unknown as NodeJS.ReadableStream).on('data', (chunk: Buffer) => chunks.push(chunk));
  (res as unknown as NodeJS.ReadableStream).on('end', () => done(null, Buffer.concat(chunks)));
}

const maybeDescribe = appleFixture ? describe : describe.skip;

maybeDescribe('Smart Wallet 2.0 Stage 4B — first issue to device registration (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    await createStudio(prisma, { id: STUDIO_ID, name: 'Stage 4B Synthetic ARES' });
  });

  afterAll(async () => {
    await app.close();
  });

  async function createMember(userId: string) {
    const password = 'password12';
    const email = userId + '@e2e.local';
    const passwordHash = await bcrypt.hash(password, 4);
    await prisma.user.create({
      data: { id: userId, email, passwordHash, firstName: 'Synthetic', lastName: 'Member' },
    });
    await createMembership(prisma, userId, STUDIO_ID, Role.MEMBER);
    const res = await request(app.getHttpServer()).post('/api/v1/auth/login')
      .send({ email, password }).expect(201);
    return (res.body as { accessToken: string }).accessToken;
  }

  async function appleArtifact(userId: string) {
    return prisma.walletPassArtifact.findFirstOrThrow({
      where: { platform: WalletPassPlatform.APPLE, walletCredential: { userId, studioId: STUDIO_ID } },
    });
  }

  it('issues a dynamic pkpass before first installation, registers a synthetic device, and keeps QR stable', async () => {
    const token = await createMember(ALLOWED_ID);
    const issued = await request(app.getHttpServer())
      .post(`/api/v1/studios/${STUDIO_ID}/wallet/credential`)
      .set('Authorization', `Bearer ${token}`).expect(200);

    const barcode = (issued.body as { barcode: string; isNew: boolean }).barcode;
    expect((issued.body as { isNew: boolean }).isNew).toBe(true);
    expect(barcode).toMatch(/^gymos:v1:/);

    const artifact = await appleArtifact(ALLOWED_ID);
    expect(artifact).toMatchObject({ passMode: WalletPassMode.DYNAMIC, passVersion: 1 });
    expect(artifact.authenticationTokenHash).toMatch(/^[0-9a-f]{64}$/);

    const pass = (await extractPassJsonFromPkpass(Buffer.from(artifact.pkpassData!))) as {
      serialNumber: string; webServiceURL?: string; authenticationToken?: string;
      barcodes: Array<{ message: string }>;
    };
    expect(pass.serialNumber).toBe(artifact.walletCredentialId);
    expect(pass.webServiceURL).toBe(DYNAMIC_WEB_SERVICE_URL);
    expect(pass.barcodes[0]?.message).toBe(barcode);
    expect(verifyPassAuthenticationToken(pass.authenticationToken!, artifact.authenticationTokenHash!)).toBe(true);

    const downloaded = await request(app.getHttpServer())
      .post(`/api/v1/studios/${STUDIO_ID}/wallet/apple`)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true).parse(binaryParser).expect(200);
    expect(Buffer.from(downloaded.body as Buffer).equals(Buffer.from(artifact.pkpassData!))).toBe(true);

    await request(app.getHttpServer())
      .post(`${PASSKIT}/devices/${DEVICE}/registrations/${DYNAMIC_PASS_TYPE}/${pass.serialNumber}`)
      .set('Authorization', `ApplePass ${pass.authenticationToken}`)
      .send({ pushToken: PUSH }).expect(201);
    const registrations = await prisma.walletPassRegistration.findMany();
    expect(registrations).toHaveLength(1);
    expect(registrations[0]).toMatchObject({
      studioId: STUDIO_ID, walletPassArtifactId: artifact.id,
      serialNumber: pass.serialNumber, pushToken: PUSH,
    });

    const again = await request(app.getHttpServer())
      .post(`/api/v1/studios/${STUDIO_ID}/wallet/credential`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect((again.body as { barcode: string; isNew: boolean }).barcode).toBe(barcode);
    expect((again.body as { isNew: boolean }).isNew).toBe(false);
    expect((await appleArtifact(ALLOWED_ID)).passMode).toBe(WalletPassMode.DYNAMIC);
  });

  it('keeps first issues outside the allowlist STATIC', async () => {
    const token = await createMember(OUTSIDE_ID);
    await request(app.getHttpServer()).post(`/api/v1/studios/${STUDIO_ID}/wallet/credential`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    const artifact = await appleArtifact(OUTSIDE_ID);
    expect(artifact.passMode).toBe(WalletPassMode.STATIC);
    expect(artifact.authenticationTokenHash).toBeNull();
    const pass = (await extractPassJsonFromPkpass(Buffer.from(artifact.pkpassData!))) as { webServiceURL?: string };
    expect(pass.webServiceURL).toBeUndefined();
    expect(await prisma.walletPassRegistration.count()).toBe(0);
  });

  it('never converts an existing STATIC pass, even for an allowlisted member', async () => {
    const token = await createMember(ALLOWED_ID);
    const credential = await prisma.walletCredential.create({
      data: { userId: ALLOWED_ID, studioId: STUDIO_ID, credentialHash: 'b'.repeat(64) },
    });
    const original = Uint8Array.from(Buffer.from('preexisting-static-pass-bytes'));
    const artifact = await prisma.walletPassArtifact.create({
      data: {
        walletCredentialId: credential.id, platform: WalletPassPlatform.APPLE,
        pkpassData: original, templateVersion: APPLE_PASS_TEMPLATE_VERSION,
      },
    });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${STUDIO_ID}/wallet/apple`)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true).parse(binaryParser).expect(200);
    expect(Buffer.from(res.body as Buffer).equals(Buffer.from(original))).toBe(true);

    const after = await prisma.walletPassArtifact.findUniqueOrThrow({ where: { id: artifact.id } });
    expect(after.passMode).toBe(WalletPassMode.STATIC);
    expect(Buffer.from(after.pkpassData!).equals(Buffer.from(original))).toBe(true);
    expect(await prisma.walletPassRegistration.count()).toBe(0);
  });
});
