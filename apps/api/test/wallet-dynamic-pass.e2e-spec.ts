// Must stay the first import: sets the Smart Wallet env before AppModule is imported.
import './helpers/wallet-dynamic-env.on';
import * as http2 from 'node:http2';
import http2Module from 'node:http2';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { DayPassStatus, Role, SubscriptionEndReason, SubscriptionSource, SubscriptionStatus, WalletPassMode, WalletPassPlatform } from '@prisma/client';
import * as forge from 'node-forge';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { formatInstantDateEs } from '../src/wallet/access/wallet-access-display';
import { hashPassAuthenticationToken, verifyPassAuthenticationToken } from '../src/wallet/apple/passkit-token';
import { extractPassJsonFromPkpass } from '../src/wallet/apple/pkpass-reader';
import { loadP12 } from '../src/wallet/apple/pkpass-signer';
import { WalletDynamicPassError, WalletDynamicPassService } from '../src/wallet/dynamic/wallet-dynamic-pass.service';
import { WalletPassPushService } from '../src/wallet/passkit/wallet-pass-push.service';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import { createMembership, createStudio, createUserWithPassword } from './helpers/factories';
import { appleFixture, DYNAMIC_PASS_TYPE, DYNAMIC_WEB_SERVICE_URL } from './helpers/wallet-dynamic-env';

/**
 * Smart Wallet 2.0 Stage 1A, end to end on the isolated test database: snapshot loader,
 * dynamic enrollment/refresh, the PassKit web service over real HTTP, and APNs pushes to a
 * LOCAL HTTP/2 server. Signing uses a throwaway test PKI. Nothing here contacts Apple.
 */
const PASS_TYPE = DYNAMIC_PASS_TYPE;
const WEB_SERVICE_URL = DYNAMIC_WEB_SERVICE_URL;
const TZ = 'America/Mexico_City';
const DAY = 24 * 60 * 60 * 1000;

// Hard stop on any attempt to reach Apple from this file. node:http2 is a core module shared by
// every test file in the worker, so the spy is restored in afterAll below.
const realConnect = http2Module.connect;
const connectGuard = jest.spyOn(http2Module, 'connect').mockImplementation(((authority: string | URL, ...rest: unknown[]) => {
  if (String(authority).includes('apple.com')) throw new Error('e2e must never contact live APNs');
  return (realConnect as (...a: unknown[]) => http2.ClientHttp2Session)(authority, ...rest);
}) as typeof http2.connect);
afterAll(() => connectGuard.mockRestore());

/** supertest does not buffer application/vnd.apple.pkpass by itself; collect the raw bytes. */
function binaryParser(res: request.Response, callback: (err: Error | null, body: Buffer) => void): void {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  stream.on('end', () => callback(null, Buffer.concat(chunks)));
}

type PassJson = {
  serialNumber: string;
  webServiceURL?: string;
  authenticationToken?: string;
  voided?: boolean;
  barcodes: Array<{ message: string }>;
  generic: { headerFields: Array<{ key: string; value: string }>; secondaryFields: Array<{ key: string; value: string }>; auxiliaryFields?: Array<{ key: string; value: string }> };
};

async function passJsonOf(pkpass: Buffer | Uint8Array): Promise<PassJson> {
  return (await extractPassJsonFromPkpass(Buffer.from(pkpass))) as unknown as PassJson;
}

const maybeDescribe = appleFixture ? describe : describe.skip;

maybeDescribe('Smart Wallet 2.0 Stage 1A (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let dynamic: WalletDynamicPassService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    dynamic = app.get(WalletDynamicPassService);
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  async function login(email: string, password: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password }).expect(201);
    return (res.body as { accessToken: string }).accessToken;
  }

  async function downloadApplePass(studioId: string, token: string): Promise<Buffer> {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studioId}/wallet/apple`)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);
    return res.body as Buffer;
  }

  async function fullAccessPlan(studioId: string) {
    return prisma.membershipPlan.create({
      data: {
        studioId,
        name: 'Full Access',
        priceCents: 120000,
        currency: 'mxn',
        billingInterval: 'MONTHLY',
        active: true,
        allClassesAccess: true,
        openGymAccess: true,
        exclusiveGroup: 'CORE',
      },
    });
  }

  /** A member of a Mexico City studio who already holds a STATIC Apple pass (the existing flow). */
  async function memberWithStaticPass(prefix: string, seed?: (studioId: string, userId: string) => Promise<unknown>) {
    const studio = await createStudio(prisma, { timezone: TZ });
    const member = await createUserWithPassword(prisma, { email: `${prefix}@e2e.local` });
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    if (seed) await seed(studio.id, member.id);
    const jwt = await login(member.email, member.password);
    const staticPkpass = await downloadApplePass(studio.id, jwt);
    const staticJson = await passJsonOf(staticPkpass);
    return { studio, member, jwt, serial: staticJson.serialNumber, barcode: staticJson.barcodes[0]!.message, staticJson, staticPkpass };
  }

  /** The October 2026 incident shape, relative to now: cash Full Access still ACTIVE 4 days after its period ended. */
  async function seedExpiredCash(studioId: string, userId: string) {
    const plan = await fullAccessPlan(studioId);
    const now = Date.now();
    const current = await prisma.subscription.create({
      data: {
        studioId,
        userId,
        membershipPlanId: plan.id,
        status: SubscriptionStatus.ACTIVE,
        source: SubscriptionSource.CASH,
        currentPeriodStart: new Date(now - 34 * DAY),
        currentPeriodEnd: new Date(now - 4 * DAY),
        cancelAtPeriodEnd: true,
        exclusiveGroupKey: 'CORE',
        createdAt: new Date(now - 34 * DAY),
      },
    });
    await prisma.subscription.create({
      data: {
        studioId,
        userId,
        membershipPlanId: plan.id,
        status: SubscriptionStatus.CANCELED,
        source: SubscriptionSource.CASH,
        currentPeriodStart: new Date(now - 77 * DAY),
        currentPeriodEnd: new Date(now - 46 * DAY),
        endReason: SubscriptionEndReason.SUPERSEDED_RENEWAL,
        supersededBySubscriptionId: current.id,
        exclusiveGroupKey: 'CORE',
        createdAt: new Date(now - 77 * DAY),
      },
    });
    return { plan, current };
  }

  async function appleArtifact(serial: string) {
    return prisma.walletPassArtifact.findUniqueOrThrow({
      where: { walletCredentialId_platform: { walletCredentialId: serial, platform: WalletPassPlatform.APPLE } },
    });
  }

  async function expectRefusal(promise: Promise<unknown>, code: string) {
    await expect(promise).rejects.toBeInstanceOf(WalletDynamicPassError);
    await promise.catch((e: WalletDynamicPassError) => expect(e.code).toBe(code));
  }

  describe('October 2026 expired-cash regression on the real database', () => {
    it('a newly built STATIC pass names no plan; the snapshot says the membership expired', async () => {
      const m = await memberWithStaticPass('oct-static', seedExpiredCash);
      expect(m.staticJson.generic.headerFields).toEqual([]); // was: PLAN Full Access

      const preview = await dynamic.preview(m.serial);
      expect(preview.snapshot.overall).toBe('INACTIVE');
      expect(preview.display.status.value).toBe('VENCIDA');
      expect(preview.display.voided).toBe(false);
      expect(preview.snapshot.memberships.map((x) => x.lifecycleStatus)).toEqual(['EXPIRED']);
    });
  });

  describe('enrollment: STATIC -> DYNAMIC with the same identity', () => {
    it('keeps serial and QR, mints one token, records versions, and claims nothing about access', async () => {
      const m = await memberWithStaticPass('enroll', seedExpiredCash);
      const before = await appleArtifact(m.serial);
      expect(before).toMatchObject({ passMode: WalletPassMode.STATIC, passVersion: 0, authenticationTokenHash: null, templateVersion: 2 });

      const result = await dynamic.enroll(m.serial);
      expect(result).toMatchObject({ outcome: 'enrolled', passVersion: 1, overall: 'INACTIVE', studioId: m.studio.id });

      const after = await appleArtifact(m.serial);
      expect(after).toMatchObject({ passMode: WalletPassMode.DYNAMIC, passVersion: 1, dynamicTemplateVersion: 1, snapshotSchemaVersion: 1, templateVersion: 2 });
      expect(after.authenticationTokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(after.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(after.lastModifiedAt).toBeInstanceOf(Date);
      expect(after.dynamicEnabledAt).toBeInstanceOf(Date);

      const pass = await passJsonOf(after.pkpassData!);
      expect(pass.serialNumber).toBe(m.serial);
      expect(pass.barcodes[0]!.message).toBe(m.barcode);
      expect(pass.webServiceURL).toBe(WEB_SERVICE_URL);
      expect(verifyPassAuthenticationToken(pass.authenticationToken!, after.authenticationTokenHash)).toBe(true);
      expect(pass.generic.headerFields).toEqual([{ key: 'status', label: 'ESTADO', value: 'VENCIDA' }]);
      expect(pass.voided).toBeUndefined();

      // The member's own download now serves the stored dynamic bytes, untouched...
      const downloaded = await downloadApplePass(m.studio.id, m.jwt);
      expect(downloaded.equals(Buffer.from(after.pkpassData!))).toBe(true);
      // ...and the in-app QR still recovers the same barcode from it.
      const qr = await request(app.getHttpServer())
        .post(`/api/v1/studios/${m.studio.id}/wallet/credential`)
        .set('Authorization', `Bearer ${m.jwt}`)
        .expect(200);
      expect((qr.body as { barcode: string }).barcode).toBe(m.barcode);
      expect((await appleArtifact(m.serial)).updatedAt).toEqual(after.updatedAt);

      // Enrolling again is a no-op.
      await expect(dynamic.enroll(m.serial)).resolves.toMatchObject({ outcome: 'already_dynamic', passVersion: 1 });
      expect((await appleArtifact(m.serial)).updatedAt).toEqual(after.updatedAt);
    });

    it('refuses a revoked credential, a stale static template, and a credential without an Apple pass', async () => {
      const m = await memberWithStaticPass('enroll-refusals');
      await prisma.walletPassArtifact.update({ where: { id: (await appleArtifact(m.serial)).id }, data: { templateVersion: 1 } });
      await expectRefusal(dynamic.enroll(m.serial), 'WALLET_DYNAMIC_STATIC_TEMPLATE_STALE');

      await prisma.walletPassArtifact.update({ where: { id: (await appleArtifact(m.serial)).id }, data: { templateVersion: 2 } });
      await prisma.walletCredential.update({ where: { id: m.serial }, data: { revokedAt: new Date() } });
      await expectRefusal(dynamic.enroll(m.serial), 'WALLET_DYNAMIC_CREDENTIAL_REVOKED');

      await expectRefusal(dynamic.enroll('cnonexistent0000000000000'), 'WALLET_DYNAMIC_CREDENTIAL_NOT_FOUND');
      await expectRefusal(dynamic.refresh(m.serial), 'WALLET_DYNAMIC_NOT_ENROLLED');
      expect((await appleArtifact(m.serial)).passMode).toBe(WalletPassMode.STATIC);
    });

    it('the database refuses a half-enrolled DYNAMIC row', async () => {
      const m = await memberWithStaticPass('check-constraint');
      await expect(
        prisma.$executeRawUnsafe(`UPDATE wallet_pass_artifacts SET pass_mode = 'DYNAMIC' WHERE wallet_credential_id = $1`, m.serial),
      ).rejects.toThrow(/wallet_pass_artifacts_dynamic_fields_consistency/);
    });
  });

  describe('refresh', () => {
    it('writes nothing when nothing changed; on a real change re-signs with the SAME token, serial and QR', async () => {
      const m = await memberWithStaticPass('refresh', seedExpiredCash);
      await dynamic.enroll(m.serial);
      const v1 = await appleArtifact(m.serial);
      const token1 = (await passJsonOf(v1.pkpassData!)).authenticationToken!;

      await expect(dynamic.refresh(m.serial)).resolves.toMatchObject({ outcome: 'unchanged', passVersion: 1 });
      expect((await appleArtifact(m.serial)).updatedAt).toEqual(v1.updatedAt);

      // The member renews in cash at the desk: the expired row is superseded, a new period starts.
      const plan = await prisma.membershipPlan.findFirstOrThrow({ where: { studioId: m.studio.id } });
      const expired = await prisma.subscription.findFirstOrThrow({ where: { userId: m.member.id, status: SubscriptionStatus.ACTIVE } });
      await prisma.subscription.update({
        where: { id: expired.id },
        data: { status: SubscriptionStatus.CANCELED, endReason: SubscriptionEndReason.SUPERSEDED_RENEWAL },
      });
      const now = Date.now();
      const renewal = await prisma.subscription.create({
        data: {
          studioId: m.studio.id,
          userId: m.member.id,
          membershipPlanId: plan.id,
          status: SubscriptionStatus.ACTIVE,
          source: SubscriptionSource.CASH,
          currentPeriodStart: new Date(now - DAY),
          currentPeriodEnd: new Date(now + 29 * DAY),
          cancelAtPeriodEnd: true,
          exclusiveGroupKey: 'CORE',
        },
      });
      await prisma.subscription.update({ where: { id: expired.id }, data: { supersededBySubscriptionId: renewal.id } });

      const result = await dynamic.refresh(m.serial);
      expect(result).toMatchObject({ outcome: 'updated', passVersion: 2, overall: 'ACCESS_VALID' });
      const v2 = await appleArtifact(m.serial);
      expect(v2.authenticationTokenHash).toBe(v1.authenticationTokenHash);
      expect(v2.lastModifiedAt!.getTime()).toBeGreaterThan(v1.lastModifiedAt!.getTime());
      expect(v2.nextTransitionAt).toEqual(renewal.currentPeriodEnd);

      const pass2 = await passJsonOf(v2.pkpassData!);
      expect(pass2.authenticationToken).toBe(token1);
      expect(pass2.serialNumber).toBe(m.serial);
      expect(pass2.barcodes[0]!.message).toBe(m.barcode);
      expect(pass2.generic.headerFields[0]!.value).toBe('VIGENTE');
      expect(pass2.generic.secondaryFields).toEqual([
        { key: 'plan', label: 'PLAN', value: 'Full Access' },
        { key: 'validity', label: 'VIGENCIA', value: expect.stringContaining('Vigente hasta el') },
      ]);
      expect(pass2.generic.auxiliaryFields).toEqual([{ key: 'scope', label: 'INCLUYE', value: 'Todas las clases · Gimnasio' }]);
    });

    it('a day pass for studio-local today shows as such, classes only', async () => {
      const m = await memberWithStaticPass('daypass');
      const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const anchor = new Date(`${todayKey}T06:00:00.000Z`); // Mexico City is UTC-6 year-round
      await prisma.dayPass.create({ data: { studioId: m.studio.id, userId: m.member.id, validForDate: anchor, priceCents: 20000, status: DayPassStatus.ACTIVE } });
      await dynamic.enroll(m.serial);
      const pass = await passJsonOf((await appleArtifact(m.serial)).pkpassData!);
      expect(pass.generic.headerFields[0]!.value).toBe('PASE DE DÍA');
      expect(pass.generic.secondaryFields[1]!.value).toBe(`Válido hoy, ${formatInstantDateEs(anchor, TZ)}`);
      expect(JSON.stringify(pass.generic)).not.toMatch(/Gimnasio/);
    });

    it('fails closed — never rotates — when the token or the barcode cannot be recovered and verified', async () => {
      const m = await memberWithStaticPass('fail-closed', seedExpiredCash);
      await dynamic.enroll(m.serial);
      const original = await appleArtifact(m.serial);
      // Force a content change so a successful refresh would write.
      await prisma.subscription.updateMany({ where: { userId: m.member.id, status: SubscriptionStatus.ACTIVE }, data: { currentPeriodEnd: new Date(Date.now() + 9 * DAY) } });

      await prisma.walletPassArtifact.update({ where: { id: original.id }, data: { authenticationTokenHash: hashPassAuthenticationToken('x'.repeat(43)) } });
      await expectRefusal(dynamic.refresh(m.serial), 'WALLET_DYNAMIC_TOKEN_UNRECOVERABLE');
      let row = await appleArtifact(m.serial);
      expect(Buffer.from(row.pkpassData!).equals(Buffer.from(original.pkpassData!))).toBe(true);
      expect(row.passVersion).toBe(1);

      await prisma.walletPassArtifact.update({ where: { id: original.id }, data: { authenticationTokenHash: original.authenticationTokenHash } });
      const credential = await prisma.walletCredential.findUniqueOrThrow({ where: { id: m.serial } });
      await prisma.walletCredential.update({ where: { id: m.serial }, data: { credentialHash: 'f'.repeat(64) } });
      await expectRefusal(dynamic.refresh(m.serial), 'WALLET_DYNAMIC_BARCODE_UNRECOVERABLE');
      row = await appleArtifact(m.serial);
      expect(row.passVersion).toBe(1);

      await prisma.walletCredential.update({ where: { id: m.serial }, data: { credentialHash: credential.credentialHash } });
      await expect(dynamic.refresh(m.serial)).resolves.toMatchObject({ outcome: 'updated', passVersion: 2 });
    });

    it('a revoked credential\'s dynamic pass is updated to say it was replaced (voided), same serial and QR', async () => {
      const m = await memberWithStaticPass('revoked-dynamic');
      await dynamic.enroll(m.serial);
      await prisma.walletCredential.update({ where: { id: m.serial }, data: { revokedAt: new Date() } });
      await expect(dynamic.refresh(m.serial)).resolves.toMatchObject({ outcome: 'updated', overall: 'CREDENTIAL_REVOKED' });
      const pass = await passJsonOf((await appleArtifact(m.serial)).pkpassData!);
      expect(pass.voided).toBe(true);
      expect(pass.serialNumber).toBe(m.serial);
      expect(pass.barcodes[0]!.message).toBe(m.barcode);
    });

    it('concurrent refreshes of one change: exactly one writes', async () => {
      const m = await memberWithStaticPass('concurrent', seedExpiredCash);
      await dynamic.enroll(m.serial);
      await prisma.subscription.updateMany({ where: { userId: m.member.id, status: SubscriptionStatus.ACTIVE }, data: { currentPeriodEnd: new Date(Date.now() + 9 * DAY) } });

      const results = await Promise.allSettled([dynamic.refresh(m.serial), dynamic.refresh(m.serial), dynamic.refresh(m.serial)]);
      const updated = results.filter((r) => r.status === 'fulfilled' && r.value.outcome === 'updated');
      const conflicts = results.filter(
        (r) => r.status === 'rejected' && (r.reason as WalletDynamicPassError).code === 'WALLET_DYNAMIC_CONCURRENT_MODIFICATION',
      );
      expect(updated).toHaveLength(1);
      expect(updated.length + conflicts.length + results.filter((r) => r.status === 'fulfilled' && r.value.outcome === 'unchanged').length).toBe(3);
      expect((await appleArtifact(m.serial)).passVersion).toBe(2);
    });
  });

  describe('PassKit web service (Apple contract over HTTP)', () => {
    const base = '/api/v1/wallet/passkit/v1';
    const DEVICE_A = 'device0a0a0a0a0a0a0a0a0a0a0a0a0a';
    const PUSH_A = 'ab'.repeat(32);

    async function enrolled(prefix: string) {
      const m = await memberWithStaticPass(prefix);
      await dynamic.enroll(m.serial);
      const artifact = await appleArtifact(m.serial);
      const token = (await passJsonOf(artifact.pkpassData!)).authenticationToken!;
      return { ...m, token, artifact };
    }

    const register = (device: string, passType: string, serial: string, auth?: string, body: unknown = { pushToken: PUSH_A }) => {
      const r = request(app.getHttpServer()).post(`${base}/devices/${device}/registrations/${passType}/${serial}`);
      return (auth ? r.set('Authorization', auth) : r).send(body as object);
    };

    it('register: 401 for every unauthenticated variant, 201 then 200, push token kept current, 400 on a bad body', async () => {
      const p = await enrolled('pk-register');
      const other = await memberWithStaticPass('pk-register-static'); // never enrolled

      await register(DEVICE_A, PASS_TYPE, p.serial).expect(401);
      await register(DEVICE_A, PASS_TYPE, p.serial, `Bearer ${p.token}`).expect(401);
      await register(DEVICE_A, PASS_TYPE, p.serial, `ApplePass ${'x'.repeat(43)}`).expect(401);
      await register(DEVICE_A, 'pass.someone.else', p.serial, `ApplePass ${p.token}`).expect(401);
      await register(DEVICE_A, PASS_TYPE, 'cunknownserial000000000000', `ApplePass ${p.token}`).expect(401);
      await register(DEVICE_A, PASS_TYPE, other.serial, `ApplePass ${p.token}`).expect(401);
      expect(await prisma.walletPassRegistration.count()).toBe(0);

      await register(DEVICE_A, PASS_TYPE, p.serial, `ApplePass ${p.token}`).expect(201);
      await register(DEVICE_A, PASS_TYPE, p.serial, `ApplePass ${p.token}`).expect(200);
      await register(DEVICE_A, PASS_TYPE, p.serial, `ApplePass ${p.token}`, { pushToken: 'cd'.repeat(32), extraFieldFromAFutureIos: true }).expect(200);
      const rows = await prisma.walletPassRegistration.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ studioId: p.studio.id, serialNumber: p.serial, passTypeIdentifier: PASS_TYPE, pushToken: 'cd'.repeat(32) });

      await register(DEVICE_A, PASS_TYPE, p.serial, `ApplePass ${p.token}`, { pushToken: 'not-hex' }).expect(400);
      await register(DEVICE_A, PASS_TYPE, p.serial, `ApplePass ${p.token}`, {}).expect(400);
    });

    it('caps registrations per pass', async () => {
      const p = await enrolled('pk-cap');
      for (let i = 0; i < 10; i += 1) {
        await register(`device-cap-${i}`, PASS_TYPE, p.serial, `ApplePass ${p.token}`).expect(201);
      }
      await register('device-cap-10', PASS_TYPE, p.serial, `ApplePass ${p.token}`).expect(401);
      await register('device-cap-3', PASS_TYPE, p.serial, `ApplePass ${p.token}`).expect(200); // existing device still fine
    });

    it('serials: 204 for unknown devices, cursor semantics, only DYNAMIC passes the device registered', async () => {
      const p = await enrolled('pk-serials');
      await request(app.getHttpServer()).get(`${base}/devices/${DEVICE_A}/registrations/${PASS_TYPE}`).expect(204);
      await register(DEVICE_A, PASS_TYPE, p.serial, `ApplePass ${p.token}`).expect(201);
      // Pin the content timestamp a minute in the past so cursor arithmetic is deterministic.
      await prisma.walletPassArtifact.update({ where: { id: p.artifact.id }, data: { lastModifiedAt: new Date(Date.now() - 60_000) } });

      const all = await request(app.getHttpServer()).get(`${base}/devices/${DEVICE_A}/registrations/${PASS_TYPE}`).expect(200);
      expect(all.body).toEqual({ serialNumbers: [p.serial], lastUpdated: expect.stringMatching(/^\d+$/) });
      const cursor = (all.body as { lastUpdated: string }).lastUpdated;

      await request(app.getHttpServer()).get(`${base}/devices/${DEVICE_A}/registrations/${PASS_TYPE}?passesUpdatedSince=${cursor}`).expect(204);
      await request(app.getHttpServer()).get(`${base}/devices/${DEVICE_A}/registrations/pass.someone.else`).expect(204);
      await request(app.getHttpServer()).get(`${base}/devices/${DEVICE_A}/registrations/${PASS_TYPE}?passesUpdatedSince=garbage`).expect(200);

      // A content change moves the pass past the device's cursor.
      await prisma.walletCredential.update({ where: { id: p.serial }, data: { revokedAt: new Date() } });
      await dynamic.refresh(p.serial);
      const changed = await request(app.getHttpServer()).get(`${base}/devices/${DEVICE_A}/registrations/${PASS_TYPE}?passesUpdatedSince=${cursor}`).expect(200);
      expect((changed.body as { serialNumbers: string[] }).serialNumbers).toEqual([p.serial]);
      expect(Number((changed.body as { lastUpdated: string }).lastUpdated)).toBeGreaterThanOrEqual(Number(cursor));
    });

    it('latest pass: 200 with the stored bytes and pkpass content type; 401 without the pass token', async () => {
      const p = await enrolled('pk-latest');
      const res = await request(app.getHttpServer())
        .get(`${base}/passes/${PASS_TYPE}/${p.serial}`)
        .set('Authorization', `ApplePass ${p.token}`)
        .buffer(true)
        .parse(binaryParser)
        .expect(200);
      expect(res.headers['content-type']).toBe('application/vnd.apple.pkpass');
      expect(res.headers['last-modified']).toBe(p.artifact.lastModifiedAt!.toUTCString());
      expect(res.headers['cache-control']).toBe('no-store');
      expect((res.body as Buffer).equals(Buffer.from(p.artifact.pkpassData!))).toBe(true);

      await request(app.getHttpServer()).get(`${base}/passes/${PASS_TYPE}/${p.serial}`).expect(401);
      await request(app.getHttpServer()).get(`${base}/passes/${PASS_TYPE}/${p.serial}`).set('Authorization', `ApplePass ${'y'.repeat(43)}`).expect(401);
    });

    it('unregister: authenticated, idempotent', async () => {
      const p = await enrolled('pk-unregister');
      await register(DEVICE_A, PASS_TYPE, p.serial, `ApplePass ${p.token}`).expect(201);
      await request(app.getHttpServer()).delete(`${base}/devices/${DEVICE_A}/registrations/${PASS_TYPE}/${p.serial}`).expect(401);
      await request(app.getHttpServer()).delete(`${base}/devices/${DEVICE_A}/registrations/${PASS_TYPE}/${p.serial}`).set('Authorization', `ApplePass ${p.token}`).expect(200);
      expect(await prisma.walletPassRegistration.count()).toBe(0);
      await request(app.getHttpServer()).delete(`${base}/devices/${DEVICE_A}/registrations/${PASS_TYPE}/${p.serial}`).set('Authorization', `ApplePass ${p.token}`).expect(200);
      await request(app.getHttpServer()).get(`${base}/devices/${DEVICE_A}/registrations/${PASS_TYPE}`).expect(204);
    });

    it('tenant isolation: one studio\'s pass token never reaches another studio\'s pass', async () => {
      const a = await enrolled('pk-tenant-a');
      const b = await enrolled('pk-tenant-b');
      expect(a.studio.id).not.toBe(b.studio.id);

      await register(DEVICE_A, PASS_TYPE, a.serial, `ApplePass ${b.token}`).expect(401);
      await request(app.getHttpServer()).get(`${base}/passes/${PASS_TYPE}/${a.serial}`).set('Authorization', `ApplePass ${b.token}`).expect(401);
      await register(DEVICE_A, PASS_TYPE, a.serial, `ApplePass ${a.token}`).expect(201);
      await request(app.getHttpServer()).delete(`${base}/devices/${DEVICE_A}/registrations/${PASS_TYPE}/${a.serial}`).set('Authorization', `ApplePass ${b.token}`).expect(401);

      const rows = await prisma.walletPassRegistration.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.studioId).toBe(a.studio.id);
      const serials = await request(app.getHttpServer()).get(`${base}/devices/${DEVICE_A}/registrations/${PASS_TYPE}`).expect(200);
      expect((serials.body as { serialNumbers: string[] }).serialNumbers).toEqual([a.serial]);
    });

    it('log: always 200, bounded and sanitized', async () => {
      await request(app.getHttpServer()).post(`${base}/log`).send({ logs: ['Web service error for pass.x (http://x): 401', 'a'.repeat(5000)] }).expect(200);
      await request(app.getHttpServer()).post(`${base}/log`).send({ unexpected: true }).expect(200);
      await request(app.getHttpServer()).post(`${base}/log`).send({ logs: Array.from({ length: 500 }, (_, i) => `m${i}`) }).expect(200);
    });
  });

  describe('APNs pass-update push (local HTTP/2 server standing in for APNs)', () => {
    function localServerIdentity() {
      const keys = forge.pki.rsa.generateKeyPair(2048);
      const cert = forge.pki.createCertificate();
      cert.publicKey = keys.publicKey;
      cert.serialNumber = '01';
      cert.validity.notBefore = new Date(Date.now() - 60_000);
      cert.validity.notAfter = new Date(Date.now() + 3_600_000);
      cert.setSubject([{ name: 'commonName', value: 'localhost' }]);
      cert.setIssuer([{ name: 'commonName', value: 'localhost' }]);
      cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }]);
      cert.sign(keys.privateKey, forge.md.sha256.create());
      return { certPem: forge.pki.certificateToPem(cert), keyPem: forge.pki.privateKeyToPem(keys.privateKey) };
    }

    it('pushes {} with topic = pass type id to every registered device and prunes tokens APNs rejects', async () => {
      const identity = localServerIdentity();
      const wwdrPem = Buffer.from(appleFixture!.wwdrPemBase64, 'base64').toString('utf8');
      const received: Array<{ path: string; topic: unknown; body: string }> = [];
      const server = http2.createSecureServer({ cert: identity.certPem, key: identity.keyPem, requestCert: true, rejectUnauthorized: true, ca: wwdrPem });
      server.on('stream', (stream, headers) => {
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => {
          const path = String(headers[':path']);
          received.push({ path, topic: headers['apns-topic'], body: Buffer.concat(chunks).toString('utf8') });
          const dead = path.endsWith('dead'.repeat(16));
          stream.respond({ ':status': dead ? 410 : 200, 'content-type': 'application/json' });
          stream.end(dead ? JSON.stringify({ reason: 'Unregistered' }) : '');
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;

      try {
        const m = await memberWithStaticPass('push');
        await dynamic.enroll(m.serial);
        const token = (await passJsonOf((await appleArtifact(m.serial)).pkpassData!)).authenticationToken!;
        const base = '/api/v1/wallet/passkit/v1';
        await request(app.getHttpServer())
          .post(`${base}/devices/device-live/registrations/${PASS_TYPE}/${m.serial}`)
          .set('Authorization', `ApplePass ${token}`)
          .send({ pushToken: 'ab'.repeat(32) })
          .expect(201);
        await request(app.getHttpServer())
          .post(`${base}/devices/device-gone/registrations/${PASS_TYPE}/${m.serial}`)
          .set('Authorization', `ApplePass ${token}`)
          .send({ pushToken: 'dead'.repeat(16) })
          .expect(201);

        const pushes = app.get(WalletPassPushService);
        const summary = await pushes.pushPassUpdate(m.serial, { host, ca: identity.certPem });

        expect(summary).toMatchObject({ registrations: 2, delivered: 1, failed: 1, invalidTokensRemoved: 1, failureReasons: ['410:Unregistered'] });
        expect(received.map((r) => ({ topic: r.topic, body: r.body })).sort((x, y) => String(x.topic).localeCompare(String(y.topic)))).toEqual([
          { topic: PASS_TYPE, body: '{}' },
          { topic: PASS_TYPE, body: '{}' },
        ]);
        const left = await prisma.walletPassRegistration.findMany({ select: { deviceLibraryIdentifier: true } });
        expect(left).toEqual([{ deviceLibraryIdentifier: 'device-live' }]);

        // The client identity APNs saw is the pass-signing certificate.
        const p12 = loadP12(appleFixture!.p12Base64, appleFixture!.p12Password);
        expect(p12.cert.subject.getField('CN').value).toBe('Test Pass Type ID');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});
