// Must stay the first import: sets the Smart Wallet env before AppModule is imported.
import './helpers/wallet-dynamic-env.on';
import * as http2 from 'node:http2';
import http2Module from 'node:http2';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role, SubscriptionSource, SubscriptionStatus, WalletPassEventType as T, WalletPassPlatform, WalletPassRefreshStatus } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { StripeService } from '../src/stripe/stripe.service';
import { AppleWalletProvider } from '../src/wallet/apple/apple-wallet-provider.service';
import { extractPassJsonFromPkpass } from '../src/wallet/apple/pkpass-reader';
import { WalletDynamicPassService } from '../src/wallet/dynamic/wallet-dynamic-pass.service';
import { ApnsClientFactory, type ApnsClientOptions } from '../src/wallet/passkit/apns.client';
import { deviceHashOf } from '../src/wallet/passkit/wallet-pass-events.service';
import { WalletPassPushService } from '../src/wallet/passkit/wallet-pass-push.service';
import { WALLET_REFRESH_LEASE_MS } from '../src/wallet/refresh/wallet-refresh.constants';
import { WalletDiagnosticsService } from '../src/wallet/refresh/wallet-diagnostics.service';
import { WalletHealthService, walletHealthNeedsAttention } from '../src/wallet/refresh/wallet-health.service';
import { WalletRefreshProcessorService } from '../src/wallet/refresh/wallet-refresh-processor.service';
import { WalletRefreshQueueService } from '../src/wallet/refresh/wallet-refresh-queue.service';
import { WalletRefreshTriggersService } from '../src/wallet/refresh/wallet-refresh-triggers.service';
import { WalletRefreshWorkerService } from '../src/wallet/refresh/wallet-refresh-worker.service';
import { buildWorld, signedPost } from './helpers/billing-reliability';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import { FakeApns } from './helpers/fake-apns';
import { createMembership, createStudio, createUserWithPassword } from './helpers/factories';
import { appleFixture, DYNAMIC_PASS_TYPE } from './helpers/wallet-dynamic-env';

/**
 * Smart Wallet 2.0 Stage 4A — delivery safety, monitoring and the remaining automatic
 * transitions, end to end on the isolated test database. APNs is a LOCAL HTTP/2 server; any
 * attempt to reach Apple fails the suite. The background timer is never started.
 */
const TZ = 'America/Mexico_City';
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const PASSKIT = '/api/v1/wallet/passkit/v1';
const TOKEN_OK = '11'.repeat(32);
const TOKEN_GONE = '22'.repeat(32);
const TOKEN_FLAKY = '33'.repeat(32);

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

maybeDescribe('Smart Wallet 2.0 Stage 4A — delivery safety, monitoring, transitions (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let dynamic: WalletDynamicPassService;
  let queue: WalletRefreshQueueService;
  let triggers: WalletRefreshTriggersService;
  let worker: WalletRefreshWorkerService;
  let pushes: WalletPassPushService;
  let health: WalletHealthService;
  let stripe: Record<string, jest.Mock>;
  let webhookSecret: string;
  const apns = new FakeApns(Buffer.from(appleFixture?.wwdrPemBase64 ?? '', 'base64').toString('utf8'));

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    dynamic = app.get(WalletDynamicPassService);
    queue = app.get(WalletRefreshQueueService);
    triggers = app.get(WalletRefreshTriggersService);
    worker = app.get(WalletRefreshWorkerService);
    pushes = app.get(WalletPassPushService);
    health = app.get(WalletHealthService);
    stripe = app.get(StripeService) as unknown as Record<string, jest.Mock>;
    webhookSecret = app.get(ConfigService).getOrThrow<string>('STRIPE_WEBHOOK_SECRET');
    await apns.start();
    const factory = app.get(ApnsClientFactory);
    const create = factory.create.bind(factory);
    jest.spyOn(factory, 'create').mockImplementation((options: ApnsClientOptions) => create({ ...options, host: apns.host, ca: apns.certPem }));
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    apns.reset();
    stripe['listSubscriptionsForCustomer']?.mockResolvedValue([]);
    stripe['findPaidInvoicePaymentIntentId']?.mockResolvedValue(null);
  });

  afterAll(async () => {
    await apns.stop();
    await app.close();
  });

  // --- helpers ---------------------------------------------------------------------------------

  async function login(email: string, password: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password }).expect(201);
    return (res.body as { accessToken: string }).accessToken;
  }

  async function serialFor(studioId: string, jwt: string): Promise<string> {
    const res = await request(app.getHttpServer()).post(`/api/v1/studios/${studioId}/wallet/apple`).set('Authorization', `Bearer ${jwt}`).buffer(true).parse(binaryParser).expect(200);
    return (await extractPassJsonFromPkpass(res.body as Buffer)).serialNumber as string;
  }

  async function plan(studioId: string) {
    return prisma.membershipPlan.create({
      data: { studioId, name: 'Full Access', priceCents: 120000, currency: 'mxn', billingInterval: 'MONTHLY', active: true, allClassesAccess: true, openGymAccess: true, exclusiveGroup: 'CORE' },
    });
  }

  async function activeCashMember(prefix: string, end = new Date(Date.now() + 29 * DAY)) {
    const studio = await createStudio(prisma, { timezone: TZ });
    const member = await createUserWithPassword(prisma, { email: `${prefix}-${Math.random().toString(36).slice(2, 8)}@e2e.local` });
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    const p = await plan(studio.id);
    const sub = await prisma.subscription.create({
      data: {
        studioId: studio.id, userId: member.id, membershipPlanId: p.id, status: SubscriptionStatus.ACTIVE, source: SubscriptionSource.CASH,
        currentPeriodStart: new Date(Date.now() - DAY), currentPeriodEnd: end, cancelAtPeriodEnd: true, exclusiveGroupKey: 'CORE',
      },
    });
    const jwt = await login(member.email, member.password);
    const serial = await serialFor(studio.id, jwt);
    await dynamic.enroll(serial);
    return { studioId: studio.id, member, sub, jwt, serial, token: (await passOf(serial)).authenticationToken as string };
  }

  function artifactOf(serial: string) {
    return prisma.walletPassArtifact.findUniqueOrThrow({ where: { walletCredentialId_platform: { walletCredentialId: serial, platform: WalletPassPlatform.APPLE } } });
  }

  async function passOf(serial: string) {
    return (await extractPassJsonFromPkpass(Buffer.from((await artifactOf(serial)).pkpassData!))) as unknown as {
      authenticationToken: string;
      barcodes: Array<{ message: string }>;
      generic: { headerFields: Array<{ value: string }> };
    };
  }

  const statusOf = async (serial: string) => (await passOf(serial)).generic.headerFields[0]!.value;

  async function registerDevice(serial: string, token: string, device: string, pushToken: string) {
    await request(app.getHttpServer())
      .post(`${PASSKIT}/devices/${device}/registrations/${DYNAMIC_PASS_TYPE}/${serial}`)
      .set('Authorization', `ApplePass ${token}`)
      .send({ pushToken })
      .expect(201);
  }

  /** Changes the member's visible state and queues one refresh, as change detection would. */
  async function changeAndEnqueue(m: { studioId: string; member: { id: string } }) {
    await prisma.subscription.updateMany({ where: { userId: m.member.id }, data: { currentPeriodEnd: new Date(Date.now() + 9 * DAY) } });
    await queue.enqueue([{ studioId: m.studioId, userId: m.member.id }], 'MANUAL');
  }

  const received = (token: string) => apns.received.filter((r) => r.token === token).length;

  /** A worker exactly as a freshly started process would build it (its own phase clock). */
  function freshWorker(): WalletRefreshWorkerService {
    return new WalletRefreshWorkerService(
      app.get(ConfigService),
      queue,
      triggers,
      app.get(WalletRefreshProcessorService),
      dynamic,
      app.get(AppleWalletProvider),
      health,
    );
  }

  // --- multi-device delivery -------------------------------------------------------------------

  describe('multiple devices per pass', () => {
    it('per-device outcomes: an invalid token is pruned, a transient failure is retried for that device only, an accepted device is not notified twice', async () => {
      apns.reply = (token) => {
        if (token === TOKEN_GONE) return { status: 410, reason: 'Unregistered' };
        if (token === TOKEN_FLAKY && received(TOKEN_FLAKY) === 1) return { status: 503, reason: 'ServiceUnavailable' };
        return { status: 200 };
      };
      const m = await activeCashMember('multi-device');
      await registerDevice(m.serial, m.token, 'device-ok', TOKEN_OK);
      await registerDevice(m.serial, m.token, 'device-gone', TOKEN_GONE);
      await registerDevice(m.serial, m.token, 'device-flaky', TOKEN_FLAKY);
      await changeAndEnqueue(m);

      const now = new Date();
      expect(await worker.processDue(now)).toEqual([expect.objectContaining({ result: 'RETRY', outcome: expect.stringContaining('APNS_TRANSIENT:503') })]);
      expect(await artifactOf(m.serial)).toMatchObject({ passVersion: 2, pushedPassVersion: 1 });
      expect((await prisma.walletPassRegistration.findMany({ select: { deviceLibraryIdentifier: true } })).map((r) => r.deviceLibraryIdentifier).sort()).toEqual(['device-flaky', 'device-ok']);

      expect(await worker.processDue(new Date(now.getTime() + 40_000))).toEqual([
        expect.objectContaining({ result: 'SUCCEEDED', outcome: `${m.serial}:unchanged:pushed:1,already:1` }),
      ]);
      expect(await artifactOf(m.serial)).toMatchObject({ passVersion: 2, pushedPassVersion: 2 });
      expect([received(TOKEN_OK), received(TOKEN_GONE), received(TOKEN_FLAKY)]).toEqual([1, 1, 2]);

      const history = await prisma.walletPassEvent.findMany({ where: { type: { in: [T.APNS_ACCEPTED, T.APNS_FAILED, T.APNS_INVALID_TOKEN] } }, orderBy: { occurredAt: 'asc' } });
      expect(history.map((e) => [e.type, e.deviceHash])).toEqual(
        expect.arrayContaining([
          [T.APNS_ACCEPTED, deviceHashOf('device-ok')],
          [T.APNS_INVALID_TOKEN, deviceHashOf('device-gone')],
          [T.APNS_FAILED, deviceHashOf('device-flaky')],
          [T.APNS_ACCEPTED, deviceHashOf('device-flaky')],
        ]),
      );
      expect(history).toHaveLength(4);

      // An operator push is deliberately not de-duplicated: it notifies every registered device.
      const manual = await pushes.pushPassUpdate(m.serial);
      expect(manual).toMatchObject({ registrations: 2, delivered: 2, alreadyAccepted: 0 });
    });

    it('a new push token re-qualifies a device that had already accepted this version', async () => {
      const m = await activeCashMember('token-rotation');
      await registerDevice(m.serial, m.token, 'device-rot', TOKEN_OK);
      await changeAndEnqueue(m);
      await worker.processDue(new Date());
      expect(received(TOKEN_OK)).toBe(1);
      // Wallet re-registers with a new token, then a retry-mode push for the same version runs.
      await request(app.getHttpServer())
        .post(`${PASSKIT}/devices/device-rot/registrations/${DYNAMIC_PASS_TYPE}/${m.serial}`)
        .set('Authorization', `ApplePass ${m.token}`)
        .send({ pushToken: TOKEN_FLAKY })
        .expect(200);
      const summary = await pushes.pushPassUpdate(m.serial, {}, { skipDevicesAlreadyAccepted: true });
      expect(summary).toMatchObject({ delivered: 1, alreadyAccepted: 0 });
      expect(received(TOKEN_FLAKY)).toBe(1);
    });

    it('a crash between notifications does not re-notify the devices that already accepted', async () => {
      apns.reply = (token) => (token === TOKEN_FLAKY && received(TOKEN_FLAKY) === 1 ? { status: 503, reason: 'ServiceUnavailable' } : { status: 200 });
      const m = await activeCashMember('crash');
      await registerDevice(m.serial, m.token, 'device-ok', TOKEN_OK);
      await registerDevice(m.serial, m.token, 'device-flaky', TOKEN_FLAKY);
      await changeAndEnqueue(m);
      const now = new Date();
      await worker.processDue(now); // device-ok accepted, device-flaky failed → RETRY

      // The retry is claimed by a worker that then dies (no completion); its lease expires.
      const retryAt = new Date(now.getTime() + 40_000);
      const [orphan] = await queue.claim('crashed-worker', retryAt, 1);
      expect(orphan).toBeDefined();
      const afterLease = new Date(retryAt.getTime() + WALLET_REFRESH_LEASE_MS + 1_000);
      expect(await queue.recoverExpiredLeases(afterLease)).toMatchObject({ requeued: 1 });
      await worker.processDue(afterLease);

      expect([received(TOKEN_OK), received(TOKEN_FLAKY)]).toEqual([1, 2]);
      expect(await artifactOf(m.serial)).toMatchObject({ passVersion: 2, pushedPassVersion: 2 });
    });
  });

  // --- pending delivery and restarts -----------------------------------------------------------

  describe('pending delivery', () => {
    it('worker restart: a version left undelivered while APNs was off is delivered by the new worker’s first tick, once', async () => {
      const m = await activeCashMember('restart');
      await registerDevice(m.serial, m.token, 'device-restart', TOKEN_OK);
      await changeAndEnqueue(m);
      const off = jest.spyOn(pushes, 'isEnabled').mockReturnValue(false);
      try {
        expect(await worker.processDue(new Date())).toEqual([expect.objectContaining({ outcome: `${m.serial}:updated:push_pending_apns_disabled` })]);
      } finally {
        off.mockRestore();
      }
      expect(received(TOKEN_OK)).toBe(0);

      const restarted = freshWorker();
      const now = new Date();
      const first = await restarted.runOnce(now);
      expect(first.phases).toHaveProperty('undelivered');
      expect(first.phases).not.toHaveProperty('reconcile'); // the first reconciliation waits 5–15 min
      expect(first.jobs).toEqual([expect.objectContaining({ result: 'SUCCEEDED', outcome: `${m.serial}:unchanged:pushed:1` })]);
      expect(received(TOKEN_OK)).toBe(1);

      // The next tick may re-detect the same data change inside the overlap window: recomputed,
      // unchanged, and — the point — not pushed again.
      const second = await restarted.runOnce(new Date(now.getTime() + 61_000));
      for (const j of second.jobs) expect(j.outcome).toBe(`${m.serial}:unchanged:no_push_needed`);
      expect(received(TOKEN_OK)).toBe(1);
      expect(await artifactOf(m.serial)).toMatchObject({ passVersion: 2, pushedPassVersion: 2 });
    });

    it('the pending-delivery sweep never pulls a retry forward through its backoff', async () => {
      apns.reply = () => ({ status: 503, reason: 'ServiceUnavailable' });
      const m = await activeCashMember('backoff');
      await registerDevice(m.serial, m.token, 'device-backoff', TOKEN_OK);
      await changeAndEnqueue(m);
      const now = new Date();
      await worker.processDue(now);
      const [pending] = await prisma.walletPassRefreshJob.findMany({ where: { status: WalletPassRefreshStatus.PENDING } });
      expect(pending!.runAfter.getTime()).toBeGreaterThan(now.getTime() + 20_000);

      expect(await triggers.sweepUndelivered(new Date(now.getTime() + 1_000))).toMatchObject({ enqueued: 0, members: 0 });
      const [after] = await prisma.walletPassRefreshJob.findMany({ where: { status: WalletPassRefreshStatus.PENDING } });
      expect(after!.runAfter).toEqual(pending!.runAfter);
    });
  });

  // --- APNs acceptance is not display ----------------------------------------------------------

  describe('APNs acceptance versus device retrieval', () => {
    it('records which device asked for the update; health names the device that never did', async () => {
      const m = await activeCashMember('fetch-gap');
      await registerDevice(m.serial, m.token, 'device-iphone', TOKEN_OK);
      await registerDevice(m.serial, m.token, 'device-ipad', TOKEN_FLAKY);
      await changeAndEnqueue(m);
      await worker.processDue(new Date());
      expect([received(TOKEN_OK), received(TOKEN_FLAKY)]).toEqual([1, 1]); // APNs accepted both

      // Only the iPhone acts on it: lists its changed passes, then downloads the new version.
      const listed = await request(app.getHttpServer()).get(`${PASSKIT}/devices/device-iphone/registrations/${DYNAMIC_PASS_TYPE}?passesUpdatedSince=1`).expect(200);
      expect((listed.body as { serialNumbers: string[] }).serialNumbers).toEqual([m.serial]);
      await request(app.getHttpServer()).get(`${PASSKIT}/passes/${DYNAMIC_PASS_TYPE}/${m.serial}`).set('Authorization', `ApplePass ${m.token}`).expect(200);

      const listedEvents = await prisma.walletPassEvent.findMany({ where: { type: T.SERIALS_LISTED } });
      expect(listedEvents.map((e) => [e.deviceHash, e.passVersion, e.httpStatus, e.detail])).toEqual([[deviceHashOf('device-iphone'), 2, 200, { listed: 1, sinceTag: true }]]);

      const later = new Date(Date.now() + 31 * MIN);
      const report = await health.evaluate(later);
      const gap = report.findings.find((f) => f.code === 'NOT_FETCHED_AFTER_PUSH');
      expect(gap).toMatchObject({ severity: 'LOW', walletCredentialId: m.serial, metrics: expect.objectContaining({ devicesNotFetched: [deviceHashOf('device-ipad')] }) });
      expect(gap!.message).toMatch(/APNs acceptance is not proof of display/);

      const diagnostics = await app.get(WalletDiagnosticsService).passReport(m.serial);
      if (!diagnostics.found) throw new Error('unreachable');
      expect(diagnostics.devicesNotFetchedSinceLastPush).toEqual([deviceHashOf('device-ipad')]);
      expect(JSON.stringify(report)).not.toMatch(/device-iphone|device-ipad|1111111111|3333333333/);
    });

    it('a device that fetched right after its own notification is not reported when another device’s retry finishes later', async () => {
      apns.reply = (token) => (token === TOKEN_FLAKY && received(TOKEN_FLAKY) === 1 ? { status: 503, reason: 'ServiceUnavailable' } : { status: 200 });
      const m = await activeCashMember('retry-fetch');
      await registerDevice(m.serial, m.token, 'device-fast', TOKEN_OK);
      await registerDevice(m.serial, m.token, 'device-slow', TOKEN_FLAKY);
      await changeAndEnqueue(m);
      const now = new Date();
      await worker.processDue(now); // device-fast accepted; device-slow failed → retry later
      await request(app.getHttpServer()).get(`${PASSKIT}/devices/device-fast/registrations/${DYNAMIC_PASS_TYPE}?passesUpdatedSince=1`).expect(200);
      await worker.processDue(new Date(now.getTime() + 40_000)); // device-slow accepted; version recorded as pushed now
      expect(await artifactOf(m.serial)).toMatchObject({ passVersion: 2, pushedPassVersion: 2 });

      const later = () => new Date(Date.now() + 31 * MIN);
      const gap = (await health.evaluate(later())).findings.find((f) => f.code === 'NOT_FETCHED_AFTER_PUSH');
      expect(gap?.metrics['devicesNotFetched']).toEqual([deviceHashOf('device-slow')]); // never device-fast

      await request(app.getHttpServer()).get(`${PASSKIT}/devices/device-slow/registrations/${DYNAMIC_PASS_TYPE}?passesUpdatedSince=1`).expect(200);
      expect((await health.evaluate(later())).findings.find((f) => f.code === 'NOT_FETCHED_AFTER_PUSH')).toBeUndefined();
    });
  });

  // --- remaining automatic transitions ---------------------------------------------------------

  describe('subscription cancellation', () => {
    async function stripeMember(suffix: string, periodEndInMs: number) {
      const w = await buildWorld(prisma, { suffix });
      const start = Math.floor((Date.now() - 29 * DAY) / 1000);
      const end = Math.floor((Date.now() + periodEndInMs) / 1000);
      await prisma.subscription.update({ where: { id: w.sub.id }, data: { currentPeriodStart: new Date(start * 1000), currentPeriodEnd: new Date(end * 1000) } });
      const serial = await serialFor(w.studio.id, await login(w.member.email, w.member.password));
      await dynamic.enroll(serial);
      return { w, serial, start, end };
    }

    it('cancelled at period end: stays VIGENTE while the paid period lasts, VENCIDA right after it ends', async () => {
      stripe['retrieveSubscription']?.mockResolvedValue({ id: 'sub_fx_full_cancel', object: 'subscription', status: 'active', cancellation_details: { reason: 'cancellation_requested' }, metadata: {}, items: { data: [] } });
      const { w, serial, start, end } = await stripeMember('_cancel', 2 * MIN);
      expect(await statusOf(serial)).toBe('VIGENTE');
      await signedPost(app, webhookSecret, w.subscriptionEvent({ type: 'customer.subscription.updated', status: 'active', cancelAtPeriodEnd: true, cancellationReason: 'cancellation_requested', periodStart: start, periodEnd: end, created: w.nowUnix() })).expect(200);
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: w.sub.id } })).cancelAtPeriodEnd).toBe(true);

      await queue.enqueue([{ studioId: w.studio.id, userId: w.member.id }], 'CHANGE_DETECTED');
      await worker.processDue(new Date());
      expect(await statusOf(serial)).toBe('VIGENTE'); // still entitled until the end of the paid period
      expect((await artifactOf(serial)).nextTransitionAt).toEqual(new Date(end * 1000));

      await triggers.sweepTransitions(new Date());
      await worker.processDue(new Date(end * 1000 + 2_000));
      expect(await statusOf(serial)).toBe('VENCIDA');
    });

    it('cancelled immediately by Stripe: the pass stops saying VIGENTE on the next refresh', async () => {
      const { w, serial } = await stripeMember('_deleted', 20 * DAY);
      const before = await artifactOf(serial);
      await signedPost(app, webhookSecret, w.subscriptionEvent({ type: 'customer.subscription.deleted' })).expect(200);
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: w.sub.id } })).status).toBe(SubscriptionStatus.CANCELED);
      await queue.enqueue([{ studioId: w.studio.id, userId: w.member.id }], 'CHANGE_DETECTED');
      await worker.processDue(new Date());
      expect(await statusOf(serial)).not.toBe('VIGENTE');
      expect((await artifactOf(serial)).passVersion).toBe(before.passVersion + 1);
    });
  });

  describe('check-in authorization never reads the pass', () => {
    it('a stale VIGENTE pass does not admit a member whose entitlement has ended', async () => {
      const m = await activeCashMember('stale-pass');
      const barcode = (await passOf(m.serial)).barcodes[0]!.message;
      expect(await statusOf(m.serial)).toBe('VIGENTE');
      // The entitlement ends in the data; the pass is NOT refreshed (worker idle) and still says VIGENTE.
      await prisma.subscription.updateMany({ where: { userId: m.member.id }, data: { currentPeriodEnd: new Date(Date.now() - MIN) } });
      expect(await statusOf(m.serial)).toBe('VIGENTE');

      const staff = await createUserWithPassword(prisma);
      await createMembership(prisma, staff.id, m.studioId, Role.STAFF);
      const staffJwt = await login(staff.email, staff.password);
      const scan = () =>
        request(app.getHttpServer()).post(`/api/v1/studios/${m.studioId}/check-ins/qr`).set('Authorization', `Bearer ${staffJwt}`).send({ qrToken: barcode });
      const denied = await scan().expect(409);
      expect(String((denied.body as { message: unknown }).message)).toContain('WALLET_MEMBERSHIP_NOT_ENTITLED');

      await queue.enqueue([{ studioId: m.studioId, userId: m.member.id }], 'MANUAL');
      await worker.processDue(new Date());
      expect(await statusOf(m.serial)).toBe('VENCIDA');
      await scan().expect(409); // same decision after the refresh: the pass never was the authority
      expect(await prisma.attendance.count()).toBe(0);
    });
  });

  // --- monitoring ------------------------------------------------------------------------------

  describe('operational health', () => {
    it('reports each condition with the right severity, the agreed wording and no identifiers beyond ids', async () => {
      const now = new Date();
      // A pass that had an update registration and lost it.
      const lost = await activeCashMember('health-lost');
      await registerDevice(lost.serial, lost.token, 'device-lost', TOKEN_OK);
      await request(app.getHttpServer()).delete(`${PASSKIT}/devices/device-lost/registrations/${DYNAMIC_PASS_TYPE}/${lost.serial}`).set('Authorization', `ApplePass ${lost.token}`).expect(200);
      // A pass whose newest version was never delivered.
      const pending = await activeCashMember('health-pending');
      await registerDevice(pending.serial, pending.token, 'device-pending', TOKEN_FLAKY);
      const pendingArtifact = await artifactOf(pending.serial);
      await prisma.walletPassArtifact.update({ where: { id: pendingArtifact.id }, data: { passVersion: 2, pushedPassVersion: 1, lastModifiedAt: new Date(now.getTime() - 40 * MIN) } });
      // Repeated APNs failures for one pass.
      const failing = await activeCashMember('health-apns');
      const failingArtifact = await artifactOf(failing.serial);
      await prisma.walletPassEvent.createMany({
        data: [1, 2, 3].map((i) => ({ studioId: failing.studioId, walletPassArtifactId: failingArtifact.id, walletCredentialId: failing.serial, type: T.APNS_FAILED, httpStatus: 503, detail: { reason: 'ServiceUnavailable' }, occurredAt: new Date(now.getTime() - i * MIN) })),
      });
      // Queue: a dead letter, a stale backlog, a stuck lease, and a burst of fresh failures.
      const job = (data: Record<string, unknown>) => ({ studioId: lost.studioId, userId: lost.member.id, reason: 'MANUAL', ...data });
      await prisma.walletPassRefreshJob.create({ data: job({ status: WalletPassRefreshStatus.FAILED, lastError: 'WALLET_DYNAMIC_TOKEN_UNRECOVERABLE', completedAt: new Date(now.getTime() - MIN) }) });
      await prisma.walletPassRefreshJob.create({ data: job({ userId: pending.member.id, studioId: pending.studioId, status: WalletPassRefreshStatus.PENDING, runAfter: new Date(now.getTime() - 20 * MIN) }) });
      await prisma.walletPassRefreshJob.create({ data: job({ userId: failing.member.id, studioId: failing.studioId, status: WalletPassRefreshStatus.RUNNING, lockedBy: 'gone', leaseExpiresAt: new Date(now.getTime() - 11 * MIN) }) });
      for (let i = 0; i < 6; i += 1) {
        await prisma.walletPassRefreshJob.create({ data: job({ status: WalletPassRefreshStatus.SUPERSEDED, lastError: 'APNS_TRANSIENT:503:ServiceUnavailable', completedAt: now }) });
      }
      await prisma.$executeRawUnsafe(`UPDATE wallet_pass_refresh_jobs SET status = 'FAILED', completed_at = now() WHERE status = 'SUPERSEDED'`);

      const report = await health.evaluate(new Date()); // after every write above
      const byCode = Object.fromEntries(report.findings.map((f) => [f.code, f]));
      expect(byCode['NO_ACTIVE_UPDATE_REGISTRATION']).toMatchObject({ severity: 'MEDIUM', walletCredentialId: lost.serial });
      expect(byCode['NO_ACTIVE_UPDATE_REGISTRATION']!.message).toMatch(/no active update registration/);
      expect(byCode['NO_ACTIVE_UPDATE_REGISTRATION']!.message).toMatch(/does not mean the pass was removed/);
      expect(byCode['UNDELIVERED_VERSION']).toMatchObject({ severity: 'MEDIUM', walletCredentialId: pending.serial, metrics: expect.objectContaining({ passVersion: 2, pushedPassVersion: 1 }) });
      expect(byCode['APNS_REPEATED_FAILURES']).toMatchObject({ severity: 'HIGH', walletCredentialId: failing.serial, metrics: expect.objectContaining({ failures24h: 3, lastReason: 'ServiceUnavailable' }) });
      expect(byCode['DEAD_LETTER_JOBS']).toMatchObject({ severity: 'HIGH', studioId: lost.studioId });
      expect(byCode['QUEUE_BACKLOG']).toMatchObject({ severity: 'MEDIUM' });
      expect(byCode['STUCK_JOBS']).toMatchObject({ severity: 'HIGH', metrics: { stuck: 1 } });
      expect(byCode['REFRESH_FAILURE_SPIKE']).toMatchObject({ severity: 'HIGH' });
      expect(byCode['CERTIFICATE_EXPIRY']).toMatchObject({ severity: 'HIGH', metrics: expect.objectContaining({ level: 'CRITICAL' }) }); // 1-day test certificate
      expect(report.maxSeverity).toBe('HIGH');
      expect(walletHealthNeedsAttention(report)).toBe(true);
      expect(report.totals).toMatchObject({ dynamicPasses: 3, undelivered: 1 });

      const json = JSON.stringify(report);
      for (const secret of ['device-lost', 'device-pending', TOKEN_OK, TOKEN_FLAKY, lost.token, pending.token]) expect(json).not.toContain(secret);
      // Every sentence that mentions removal says it is NOT what zero registrations means.
      for (const sentence of json.match(/[^."]*removed[^."]*/g) ?? []) expect(sentence).toMatch(/does not mean/);
    });

    it('a healthy system reports nothing to act on', async () => {
      const m = await activeCashMember('health-ok');
      await registerDevice(m.serial, m.token, 'device-ok', TOKEN_OK);
      const report = await health.evaluate(new Date());
      expect(report.findings.filter((f) => f.code !== 'CERTIFICATE_EXPIRY')).toEqual([]);
    });
  });
});
