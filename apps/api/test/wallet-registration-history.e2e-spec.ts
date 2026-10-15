// Must stay the first import: sets the Smart Wallet env before AppModule is imported.
import './helpers/wallet-dynamic-env.on';
import * as http2 from 'node:http2';
import http2Module from 'node:http2';
import type { INestApplication } from '@nestjs/common';
import { Role, SubscriptionSource, SubscriptionStatus, WalletPassEventType as T, WalletPassPlatform, WalletPassRefreshStatus } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { extractPassJsonFromPkpass } from '../src/wallet/apple/pkpass-reader';
import { WalletDynamicPassService } from '../src/wallet/dynamic/wallet-dynamic-pass.service';
import { ApnsClientFactory, type ApnsClientOptions } from '../src/wallet/passkit/apns.client';
import { deviceHashOf } from '../src/wallet/passkit/wallet-pass-events.service';
import { WalletPassPushService } from '../src/wallet/passkit/wallet-pass-push.service';
import { WalletDiagnosticsService } from '../src/wallet/refresh/wallet-diagnostics.service';
import { WalletRefreshTriggersService } from '../src/wallet/refresh/wallet-refresh-triggers.service';
import { WalletRefreshWorkerService } from '../src/wallet/refresh/wallet-refresh-worker.service';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import { FakeApns } from './helpers/fake-apns';
import { createMembership, createStudio, createUserWithPassword } from './helpers/factories';
import { appleFixture, DYNAMIC_PASS_TYPE } from './helpers/wallet-dynamic-env';

/**
 * Smart Wallet 2.0 Stage 3 — registration visibility. Every PassKit request and APNs outcome is
 * recorded in wallet_pass_events (device as a hash, never a token), 200 and 304 are distinct, and
 * the read-only diagnostics describe lost registrations cautiously. Nothing here contacts Apple.
 */
const TZ = 'America/Mexico_City';
const DAY = 24 * 60 * 60_000;
const PASSKIT = '/api/v1/wallet/passkit/v1';
const DEVICE = 'device0a0a0a0a0a0a0a0a0a0a0a0a0a';
const PUSH_1 = 'ab'.repeat(32);
const PUSH_2 = 'cd'.repeat(32);

const realConnect = http2Module.connect;
const connectGuard = jest.spyOn(http2Module, 'connect').mockImplementation(((authority: string | URL, ...rest: unknown[]) => {
  if (String(authority).includes('apple.com')) throw new Error('e2e must never contact live APNs');
  return (realConnect as (...a: unknown[]) => http2.ClientHttp2Session)(authority, ...rest);
}) as typeof http2.connect);
afterAll(() => connectGuard.mockRestore());

function binaryParser(res: request.Response, callback: (err: Error | null, body: Buffer) => void): void {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  stream.on('end', () => callback(null, Buffer.concat(chunks)));
}

const maybeDescribe = appleFixture ? describe : describe.skip;

maybeDescribe('Smart Wallet 2.0 Stage 3 — registration history and diagnostics (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let dynamic: WalletDynamicPassService;
  let diagnostics: WalletDiagnosticsService;
  const apns = new FakeApns(Buffer.from(appleFixture?.wwdrPemBase64 ?? '', 'base64').toString('utf8'));

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    dynamic = app.get(WalletDynamicPassService);
    diagnostics = app.get(WalletDiagnosticsService);
    await apns.start();
    const factory = app.get(ApnsClientFactory);
    const create = factory.create.bind(factory);
    jest.spyOn(factory, 'create').mockImplementation((options: ApnsClientOptions) => create({ ...options, host: apns.host, ca: apns.certPem }));
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    apns.reset();
  });

  afterAll(async () => {
    await apns.stop();
    await app.close();
  });

  async function enrolledMember(prefix: string) {
    const studio = await createStudio(prisma, { timezone: TZ });
    const member = await createUserWithPassword(prisma, { email: `${prefix}@e2e.local` });
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    const plan = await prisma.membershipPlan.create({
      data: { studioId: studio.id, name: 'Full Access', priceCents: 120000, currency: 'mxn', billingInterval: 'MONTHLY', active: true, exclusiveGroup: 'CORE' },
    });
    await prisma.subscription.create({
      data: {
        studioId: studio.id, userId: member.id, membershipPlanId: plan.id, status: SubscriptionStatus.ACTIVE, source: SubscriptionSource.CASH,
        currentPeriodStart: new Date(Date.now() - DAY), currentPeriodEnd: new Date(Date.now() + 29 * DAY), cancelAtPeriodEnd: true, exclusiveGroupKey: 'CORE',
      },
    });
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: member.email, password: member.password }).expect(201);
    const jwt = (login.body as { accessToken: string }).accessToken;
    const staticPass = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/wallet/apple`)
      .set('Authorization', `Bearer ${jwt}`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);
    const serial = (await extractPassJsonFromPkpass(staticPass.body as Buffer)).serialNumber as string;
    await dynamic.enroll(serial);
    const artifact = await artifactOf(serial);
    const pass = (await extractPassJsonFromPkpass(Buffer.from(artifact.pkpassData!))) as { authenticationToken: string; barcodes: Array<{ message: string }> };
    return { studioId: studio.id, member, plan, serial, artifact, token: pass.authenticationToken, barcode: pass.barcodes[0]!.message };
  }

  function artifactOf(serial: string) {
    return prisma.walletPassArtifact.findUniqueOrThrow({
      where: { walletCredentialId_platform: { walletCredentialId: serial, platform: WalletPassPlatform.APPLE } },
    });
  }

  const register = (serial: string, token: string | null, pushToken = PUSH_1, device = DEVICE) => {
    const r = request(app.getHttpServer()).post(`${PASSKIT}/devices/${device}/registrations/${DYNAMIC_PASS_TYPE}/${serial}`);
    return (token ? r.set('Authorization', `ApplePass ${token}`) : r).send({ pushToken });
  };
  const unregister = (serial: string, token: string, device = DEVICE) =>
    request(app.getHttpServer()).delete(`${PASSKIT}/devices/${device}/registrations/${DYNAMIC_PASS_TYPE}/${serial}`).set('Authorization', `ApplePass ${token}`);
  const latest = (serial: string, token: string, ifModifiedSince?: string) => {
    const r = request(app.getHttpServer()).get(`${PASSKIT}/passes/${DYNAMIC_PASS_TYPE}/${serial}`).set('Authorization', `ApplePass ${token}`);
    return (ifModifiedSince ? r.set('If-Modified-Since', ifModifiedSince) : r).buffer(true).parse(binaryParser);
  };
  const events = () => prisma.walletPassEvent.findMany({ orderBy: { occurredAt: 'asc' } });

  it('records registration lifecycle and distinguishes 200 (pass body) from 304 (not modified)', async () => {
    const p = await enrolledMember('history');
    await register(p.serial, null).expect(401);
    await register(p.serial, 'x'.repeat(43)).expect(401);
    expect(await prisma.walletPassEvent.count()).toBe(0); // unauthenticated requests leave no history

    await register(p.serial, p.token).expect(201);
    await register(p.serial, p.token).expect(200);
    await register(p.serial, p.token, PUSH_2).expect(200);

    const full = await latest(p.serial, p.token).expect(200);
    expect(full.headers['content-type']).toBe('application/vnd.apple.pkpass');
    expect((full.body as Buffer).equals(Buffer.from(p.artifact.pkpassData!))).toBe(true);
    const lastModified = full.headers['last-modified'] as string;
    expect(lastModified).toBe(p.artifact.lastModifiedAt!.toUTCString());

    const notModified = await latest(p.serial, p.token, lastModified).expect(304);
    expect((notModified.body as Buffer).length).toBe(0);
    expect(notModified.headers['last-modified']).toBe(lastModified);
    expect(notModified.headers['cache-control']).toBe('no-store');
    expect(notModified.headers['content-type']).toBeUndefined();

    const older = new Date(p.artifact.lastModifiedAt!.getTime() - 5000).toUTCString();
    await latest(p.serial, p.token, older).expect(200);
    await latest(p.serial, p.token, 'not a date').expect(200);

    await unregister(p.serial, p.token).expect(200);
    await unregister(p.serial, p.token).expect(200);

    const hash = deviceHashOf(DEVICE);
    const rows = await events();
    expect(rows.map((e) => [e.type, e.httpStatus, e.deviceHash, e.passVersion, e.detail])).toEqual([
      [T.REGISTERED, 201, hash, 1, { outcome: 'created', pushTokenChanged: false }],
      [T.REGISTERED, 200, hash, 1, { outcome: 'existing', pushTokenChanged: false }],
      [T.REGISTERED, 200, hash, 1, { outcome: 'existing', pushTokenChanged: true }],
      [T.PASS_RETRIEVED, 200, null, 1, { bytes: p.artifact.pkpassData!.length, ifModifiedSince: false }],
      [T.PASS_NOT_MODIFIED, 304, null, 1, null],
      [T.PASS_RETRIEVED, 200, null, 1, { bytes: p.artifact.pkpassData!.length, ifModifiedSince: true }],
      [T.PASS_RETRIEVED, 200, null, 1, { bytes: p.artifact.pkpassData!.length, ifModifiedSince: true }],
      [T.UNREGISTERED, 200, hash, 1, { removed: 1, registrationAgeMs: expect.any(Number) }],
      [T.UNREGISTERED, 200, hash, 1, { removed: 0, registrationAgeMs: null }],
    ]);
    expect(rows.every((e) => e.studioId === p.studioId && e.walletCredentialId === p.serial && e.walletPassArtifactId === p.artifact.id)).toBe(true);
  });

  it('never stores a device identifier, push token, authentication token or QR value', async () => {
    const p = await enrolledMember('no-secrets');
    await register(p.serial, p.token).expect(201);
    await register(p.serial, p.token, PUSH_2).expect(200);
    await latest(p.serial, p.token).expect(200);
    apns.reply = (token) => (token === PUSH_2 ? { status: 200 } : { status: 410, reason: 'Unregistered' });
    await app.get(WalletPassPushService).pushPassUpdate(p.serial);
    await unregister(p.serial, p.token).expect(200);

    const [dump] = await prisma.$queryRawUnsafe<Array<{ t: string }>>(`SELECT string_agg(e::text, '\n') AS t FROM wallet_pass_events e`);
    for (const secret of [DEVICE, PUSH_1, PUSH_2, p.token, p.barcode, p.barcode.replace(/^gymos:v1:/, '')]) {
      expect(dump!.t).not.toContain(secret);
    }
    expect(dump!.t).toContain(deviceHashOf(DEVICE));
  });

  it('APNs outcomes are recorded per device: accepted (with apns-id) and invalid token (pruned)', async () => {
    const p = await enrolledMember('apns-events');
    await register(p.serial, p.token, PUSH_1, 'device-live').expect(201);
    await register(p.serial, p.token, PUSH_2, 'device-gone').expect(201);
    apns.reply = (token) => (token === PUSH_2 ? { status: 410, reason: 'Unregistered' } : { status: 200 });
    const summary = await app.get(WalletPassPushService).pushPassUpdate(p.serial);
    expect(summary).toMatchObject({ delivered: 1, invalidTokensRemoved: 1, passVersion: 1 });

    const apnsEvents = (await events()).filter((e) => e.type === T.APNS_ACCEPTED || e.type === T.APNS_INVALID_TOKEN);
    expect(apnsEvents.map((e) => [e.type, e.deviceHash, e.httpStatus, e.detail]).sort()).toEqual(
      [
        [T.APNS_ACCEPTED, deviceHashOf('device-live'), 200, { apnsId: '22222222-2222-4222-8222-222222222222', reason: null, pruned: false }],
        [T.APNS_INVALID_TOKEN, deviceHashOf('device-gone'), 410, { apnsId: '22222222-2222-4222-8222-222222222222', reason: 'Unregistered', pruned: true }],
      ].sort(),
    );
  });

  it('a version written within the same second as the previous one still gets a later Last-Modified (no stale 304)', async () => {
    const p = await enrolledMember('same-second');
    const v1 = p.artifact.lastModifiedAt!;
    // Make the stored timestamp "now" so the next write lands inside the same second.
    await prisma.walletPassArtifact.update({ where: { id: p.artifact.id }, data: { lastModifiedAt: new Date() } });
    const held = (await artifactOf(p.serial)).lastModifiedAt!;
    await prisma.subscription.updateMany({ where: { userId: p.member.id }, data: { currentPeriodEnd: new Date(Date.now() + 9 * DAY) } });
    await dynamic.refresh(p.serial);
    const v2 = (await artifactOf(p.serial)).lastModifiedAt!;
    expect(Math.floor(v2.getTime() / 1000)).toBeGreaterThan(Math.floor(held.getTime() / 1000));
    expect(v2.getTime()).toBeGreaterThan(v1.getTime());
    await latest(p.serial, p.token, held.toUTCString()).expect(200);
    await latest(p.serial, p.token, v2.toUTCString()).expect(304);
  });

  describe('read-only diagnostics', () => {
    it('reports the in-place replacement pattern as churn, never as an uninstall, without identifiers', async () => {
      const p = await enrolledMember('diag-churn');
      await latest(p.serial, p.token).expect(200);
      await register(p.serial, p.token).expect(201);
      await unregister(p.serial, p.token).expect(200);

      const report = await diagnostics.passReport(p.serial);
      expect(report).toMatchObject({
        found: true,
        passMode: 'DYNAMIC',
        passVersion: 1,
        pushedPassVersion: 1,
        undeliveredVersion: false,
        activeDeviceCount: 0,
        registrations: [],
        churnSuspectedDevices: [deviceHashOf(DEVICE)],
      });
      if (!report.found) throw new Error('unreachable');
      expect(report.findings.map((f) => f.split(':')[0])).toEqual(['NO_ACTIVE_REGISTRATION', 'REGISTRATION_CHURN']);
      expect(report.caveat).toMatch(/does not prove the pass was removed/);
      const json = JSON.stringify(report);
      for (const secret of [DEVICE, PUSH_1, p.token, p.barcode]) expect(json).not.toContain(secret);

      // The member opens the pass and Wallet re-registers (the Stage 2 recovery): no churn finding.
      await register(p.serial, p.token).expect(201);
      const recovered = await diagnostics.passReport(p.serial);
      if (!recovered.found) throw new Error('unreachable');
      expect(recovered.activeDeviceCount).toBe(1);
      expect(recovered.registrations).toEqual([{ device: deviceHashOf(DEVICE), pushTokenLength: 64, createdAt: expect.any(Date), updatedAt: expect.any(Date) }]);
      expect(recovered.churnSuspectedDevices).toEqual([]);
      expect(recovered.findings).toEqual([]);
      expect(recovered.currentVersionRetrieved).toBe(true);
    });

    it('studio report: per-pass signals, queue state, strictly scoped to the studio', async () => {
      const a = await enrolledMember('diag-a');
      const b = await enrolledMember('diag-b');
      await register(a.serial, a.token).expect(201);
      await app.get(WalletRefreshTriggersService).reconcileAll(new Date());

      const report = await diagnostics.studioReport(a.studioId, new Date());
      expect(report).toMatchObject({ dynamicPasses: 1, withActiveRegistration: 1, withoutActiveRegistration: 0, churnSuspected: 0, undelivered: 0 });
      expect(report.passes.map((x) => x.walletCredentialId)).toEqual([a.serial]);
      expect(report.queue.byStatus).toEqual({ [WalletPassRefreshStatus.PENDING]: 1 });
      expect(JSON.stringify(report)).not.toContain(b.serial);
      expect(JSON.stringify(report)).not.toContain(DEVICE);
    });

    it('certificate report and worker check grade the signing certificate (the 1-day test certificate is CRITICAL)', async () => {
      const report = diagnostics.certificateReport(new Date());
      expect(report).toMatchObject({ configured: true, level: 'CRITICAL', daysLeft: 0 });
      expect(app.get(WalletRefreshWorkerService).checkCertificate(new Date())).toMatchObject({ level: 'CRITICAL', daysLeft: 0 });
      expect(app.get(WalletRefreshWorkerService).checkCertificate(new Date(Date.now() + 2 * DAY))).toMatchObject({ level: 'EXPIRED' });
    });
  });

  it('retention: history older than 180 days and finished jobs past their windows are deleted; recent rows stay', async () => {
    const p = await enrolledMember('retention');
    const now = new Date();
    const ago = (days: number) => new Date(now.getTime() - days * DAY);
    const base = { studioId: p.studioId, walletPassArtifactId: p.artifact.id, walletCredentialId: p.serial };
    await prisma.walletPassEvent.createMany({
      data: [
        { ...base, type: T.REGISTERED, occurredAt: ago(181) },
        { ...base, type: T.PASS_RETRIEVED, occurredAt: ago(179) },
      ],
    });
    const job = (status: WalletPassRefreshStatus, completedDaysAgo: number | null) => ({
      studioId: p.studioId,
      userId: p.member.id,
      status,
      reason: 'MANUAL',
      runAfter: ago(200),
      completedAt: completedDaysAgo === null ? null : ago(completedDaysAgo),
    });
    await prisma.walletPassRefreshJob.createMany({
      data: [
        job(WalletPassRefreshStatus.SUCCEEDED, 31),
        job(WalletPassRefreshStatus.SUCCEEDED, 29),
        job(WalletPassRefreshStatus.SUPERSEDED, 31),
        job(WalletPassRefreshStatus.FAILED, 91),
        job(WalletPassRefreshStatus.FAILED, 31),
      ],
    });

    expect(await app.get(WalletRefreshTriggersService).applyRetention(now)).toEqual({ events: 1, jobs: 2, failedJobs: 1 });
    expect((await events()).map((e) => e.type)).toEqual([T.PASS_RETRIEVED]);
    const left = await prisma.walletPassRefreshJob.findMany({ select: { status: true, completedAt: true } });
    expect(left.map((j) => j.status).sort()).toEqual([WalletPassRefreshStatus.FAILED, WalletPassRefreshStatus.SUCCEEDED]);
  });
});
