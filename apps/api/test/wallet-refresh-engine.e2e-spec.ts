// Must stay the first import: sets the Smart Wallet env before AppModule is imported.
import './helpers/wallet-dynamic-env.on';
import * as http2 from 'node:http2';
import http2Module from 'node:http2';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DayPassStatus,
  Role,
  SubscriptionSource,
  SubscriptionStatus,
  WalletPassMode,
  WalletPassPlatform,
  WalletPassRefreshStatus,
} from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { StripeService } from '../src/stripe/stripe.service';
import { formatInstantDateEs } from '../src/wallet/access/wallet-access-display';
import { hashPassAuthenticationToken } from '../src/wallet/apple/passkit-token';
import { extractPassJsonFromPkpass } from '../src/wallet/apple/pkpass-reader';
import { WalletDynamicPassService } from '../src/wallet/dynamic/wallet-dynamic-pass.service';
import { ApnsClientFactory, type ApnsClientOptions } from '../src/wallet/passkit/apns.client';
import { WalletPassPushService } from '../src/wallet/passkit/wallet-pass-push.service';
import {
  WALLET_REFRESH_CHANGE_CURSOR,
  WALLET_REFRESH_DEAD_LETTER_COOLDOWN_MS,
  WALLET_REFRESH_LEASE_MS,
  WALLET_REFRESH_MAX_ATTEMPTS,
} from '../src/wallet/refresh/wallet-refresh.constants';
import { WalletRefreshProcessorService } from '../src/wallet/refresh/wallet-refresh-processor.service';
import { WalletRefreshQueueService } from '../src/wallet/refresh/wallet-refresh-queue.service';
import { WalletRefreshTriggersService } from '../src/wallet/refresh/wallet-refresh-triggers.service';
import { WalletRefreshWorkerService } from '../src/wallet/refresh/wallet-refresh-worker.service';
import { buildWorld, signedPost } from './helpers/billing-reliability';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import { FakeApns } from './helpers/fake-apns';
import { createClassTemplate, createConfirmedBooking, createMembership, createScheduledClass, createStudio, createUserWithPassword } from './helpers/factories';
import { appleFixture, DYNAMIC_PASS_TYPE } from './helpers/wallet-dynamic-env';

/**
 * Smart Wallet 2.0 Stage 3 — the automatic refresh engine end to end on the isolated test
 * database: committed entitlement changes and time boundaries become durable refresh jobs, jobs
 * re-sign only changed passes, and changed passes are pushed (to a LOCAL HTTP/2 server standing
 * in for APNs). The background timer is never started here: tests drive each phase with an
 * explicit clock. Nothing here contacts Apple or Stripe.
 */
const TZ = 'America/Mexico_City';
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const PASSKIT = '/api/v1/wallet/passkit/v1';

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

type PassJson = {
  serialNumber: string;
  authenticationToken?: string;
  voided?: boolean;
  barcodes: Array<{ message: string }>;
  generic: { headerFields: Array<{ value: string }>; secondaryFields: Array<{ key: string; value: string }> };
};

const maybeDescribe = appleFixture ? describe : describe.skip;

maybeDescribe('Smart Wallet 2.0 Stage 3 — automatic refresh engine (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let dynamic: WalletDynamicPassService;
  let queue: WalletRefreshQueueService;
  let triggers: WalletRefreshTriggersService;
  let worker: WalletRefreshWorkerService;
  let pushes: WalletPassPushService;
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
    stripe = app.get(StripeService) as unknown as Record<string, jest.Mock>;
    webhookSecret = app.get(ConfigService).getOrThrow<string>('STRIPE_WEBHOOK_SECRET');
    await apns.start();
    // Point the REAL APNs client at the local server; production code paths are unchanged.
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

  // ---------------------------------------------------------------------------------------------
  // helpers

  async function login(email: string, password: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password }).expect(201);
    return (res.body as { accessToken: string }).accessToken;
  }

  async function downloadApplePass(studioId: string, jwt: string): Promise<Buffer> {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studioId}/wallet/apple`)
      .set('Authorization', `Bearer ${jwt}`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);
    return res.body as Buffer;
  }

  async function plan(studioId: string, data: { name?: string; exclusiveGroup?: string | null; entitlementDays?: number } = {}) {
    return prisma.membershipPlan.create({
      data: {
        studioId,
        name: data.name ?? 'Full Access',
        priceCents: 120000,
        currency: 'mxn',
        billingInterval: 'MONTHLY',
        active: true,
        allClassesAccess: true,
        openGymAccess: true,
        exclusiveGroup: data.exclusiveGroup === undefined ? 'CORE' : data.exclusiveGroup,
        ...(data.entitlementDays ? { entitlementDays: data.entitlementDays } : {}),
      },
    });
  }

  async function cash(studioId: string, userId: string, planId: string, start: Date, end: Date, group: string | null = 'CORE') {
    return prisma.subscription.create({
      data: {
        studioId,
        userId,
        membershipPlanId: planId,
        status: SubscriptionStatus.ACTIVE,
        source: SubscriptionSource.CASH,
        currentPeriodStart: start,
        currentPeriodEnd: end,
        cancelAtPeriodEnd: true,
        exclusiveGroupKey: group,
      },
    });
  }

  /** Member of a Mexico City studio with a DYNAMIC Apple pass (static first, then enrolled). */
  async function dynamicMember(prefix: string, seed?: (studioId: string, userId: string) => Promise<unknown>, existingStudioId?: string) {
    const studioId = existingStudioId ?? (await createStudio(prisma, { timezone: TZ })).id;
    const member = await createUserWithPassword(prisma, { email: `${prefix}-${Math.random().toString(36).slice(2, 8)}@e2e.local` });
    await createMembership(prisma, member.id, studioId, Role.MEMBER);
    if (seed) await seed(studioId, member.id);
    const jwt = await login(member.email, member.password);
    const serial = (await extractPassJsonFromPkpass(await downloadApplePass(studioId, jwt))).serialNumber as string;
    await dynamic.enroll(serial);
    const artifact = await artifactOf(serial);
    const pass = await passOf(serial);
    return { studioId, member, jwt, serial, artifact, token: pass.authenticationToken!, barcode: pass.barcodes[0]!.message };
  }

  async function artifactOf(serial: string) {
    return prisma.walletPassArtifact.findUniqueOrThrow({
      where: { walletCredentialId_platform: { walletCredentialId: serial, platform: WalletPassPlatform.APPLE } },
    });
  }

  async function passOf(serial: string): Promise<PassJson> {
    return (await extractPassJsonFromPkpass(Buffer.from((await artifactOf(serial)).pkpassData!))) as unknown as PassJson;
  }

  const statusOf = async (serial: string) => (await passOf(serial)).generic.headerFields[0]!.value;
  const planOf = async (serial: string) => (await passOf(serial)).generic.secondaryFields.find((f) => f.key === 'plan')?.value ?? null;
  const validityOf = async (serial: string) => (await passOf(serial)).generic.secondaryFields.find((f) => f.key === 'validity')?.value ?? null;

  async function registerDevice(serial: string, token: string, device: string, pushToken: string) {
    await request(app.getHttpServer())
      .post(`${PASSKIT}/devices/${device}/registrations/${DYNAMIC_PASS_TYPE}/${serial}`)
      .set('Authorization', `ApplePass ${token}`)
      .send({ pushToken })
      .expect(201);
  }

  /**
   * Makes everything created so far look old (outside the detector's overlap window) and moves
   * the change cursor to now, so the next detectChanges() sees only what the test does next.
   */
  async function settle(now = new Date()) {
    for (const table of ['subscriptions', 'day_passes', 'wallet_credentials', 'studio_memberships', 'membership_plans', 'users', 'studios']) {
      await prisma.$executeRawUnsafe(`UPDATE "${table}" SET updated_at = updated_at - interval '1 hour'`);
    }
    await prisma.$executeRawUnsafe(`UPDATE membership_entitlement_cycles SET created_at = created_at - interval '1 hour'`);
    await prisma.walletRefreshCursor.upsert({
      where: { source: WALLET_REFRESH_CHANGE_CURSOR },
      create: { source: WALLET_REFRESH_CHANGE_CURSOR, position: now },
      update: { position: now },
    });
  }

  async function detectAndProcess(now = new Date()) {
    const detection = await triggers.detectChanges(now);
    const jobs = await worker.processDue(now, 50);
    return { detection, jobs };
  }

  async function jobsOf(studioId: string, userId: string) {
    return prisma.walletPassRefreshJob.findMany({ where: { studioId, userId }, orderBy: { createdAt: 'asc' } });
  }

  async function checksum(table: string): Promise<string> {
    const [row] = await prisma.$queryRawUnsafe<Array<{ c: string | null }>>(`SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS c FROM "${table}" t`);
    return row!.c ?? '';
  }

  // ---------------------------------------------------------------------------------------------

  describe('defaults', () => {
    it('the background worker is OFF unless WALLET_REFRESH_WORKER_ENABLED=true (unset here)', () => {
      expect(worker.isEnabled()).toBe(false);
      expect(worker.start()).toBe(false);
    });

    it('nothing happens for members without a dynamic pass; static artifacts are never touched', async () => {
      const studio = await createStudio(prisma, { timezone: TZ });
      const member = await createUserWithPassword(prisma);
      await createMembership(prisma, member.id, studio.id, Role.MEMBER);
      const p = await plan(studio.id);
      await cash(studio.id, member.id, p.id, new Date(Date.now() - DAY), new Date(Date.now() + 29 * DAY));
      const serial = (await extractPassJsonFromPkpass(await downloadApplePass(studio.id, await login(member.email, member.password)))).serialNumber as string;
      const before = await artifactOf(serial);

      const tick = await worker.runOnce(new Date(), { force: true });
      expect(tick.jobs).toEqual([]);
      expect(await prisma.walletPassRefreshJob.count()).toBe(0);
      const after = await artifactOf(serial);
      expect(after).toEqual(before);
      expect(after).toMatchObject({ passMode: WalletPassMode.STATIC, passVersion: 0, pushedPassVersion: 0 });
      await expect(app.get(WalletRefreshProcessorService).processMember({ studioId: studio.id, userId: member.id }, new Date())).resolves.toBe('no_dynamic_pass');
    });
  });

  describe('entitlement changes committed by existing flows refresh the pass (change detection)', () => {
    it('cash renewal at the desk: VENCIDA -> VIGENTE, pushed once, identity and QR unchanged; repeats are no-ops', async () => {
      const m = await dynamicMember('cash-renewal', async (studioId, userId) => {
        const p = await plan(studioId);
        await cash(studioId, userId, p.id, new Date(Date.now() - 34 * DAY), new Date(Date.now() - 4 * DAY));
      });
      expect(await statusOf(m.serial)).toBe('VENCIDA');
      expect(m.artifact).toMatchObject({ passVersion: 1, pushedPassVersion: 1 });
      await registerDevice(m.serial, m.token, 'device-renewal', 'ab'.repeat(32));
      await settle();

      // Nothing changed yet: the detector enqueues nothing.
      expect((await triggers.detectChanges(new Date())).enqueued).toBe(0);

      const owner = await createUserWithPassword(prisma);
      await createMembership(prisma, owner.id, m.studioId, Role.OWNER);
      const planRow = await prisma.membershipPlan.findFirstOrThrow({ where: { studioId: m.studioId } });
      await request(app.getHttpServer())
        .post(`/api/v1/studios/${m.studioId}/members/${m.member.id}/offline-subscriptions`)
        .set('Authorization', `Bearer ${await login(owner.email, owner.password)}`)
        .send({ planId: planRow.id, amountCents: 120000, paymentMethod: 'CASH' })
        .expect(201);

      const first = await detectAndProcess();
      expect(first.detection).toMatchObject({ skipped: false, enqueued: 1, candidates: 1 });
      expect(first.jobs).toEqual([expect.objectContaining({ result: 'SUCCEEDED', outcome: `${m.serial}:updated:pushed:1` })]);
      expect(await statusOf(m.serial)).toBe('VIGENTE');
      const v2 = await artifactOf(m.serial);
      expect(v2).toMatchObject({ passVersion: 2, pushedPassVersion: 2, authenticationTokenHash: m.artifact.authenticationTokenHash });
      expect(v2.lastPushedAt).toBeInstanceOf(Date);
      const pass = await passOf(m.serial);
      expect(pass.serialNumber).toBe(m.serial);
      expect(pass.barcodes[0]!.message).toBe(m.barcode);
      expect(pass.authenticationToken).toBe(m.token);
      expect(apns.received).toEqual([{ token: 'ab'.repeat(32), topic: DYNAMIC_PASS_TYPE, body: '{}' }]);

      // The same change is still inside the overlap window: re-detected, recomputed, unchanged, not re-pushed.
      const second = await detectAndProcess();
      expect(second.jobs).toEqual([expect.objectContaining({ result: 'SUCCEEDED', outcome: `${m.serial}:unchanged:no_push_needed` })]);
      expect((await artifactOf(m.serial)).passVersion).toBe(2);
      expect(apns.received).toHaveLength(1);
    });

    it('Stripe payment failure and recovery: VIGENTE -> PAGO PENDIENTE -> VIGENTE, each pushed', async () => {
      stripe['listSubscriptionsForCustomer']?.mockResolvedValue([]);
      stripe['findPaidInvoicePaymentIntentId']?.mockResolvedValue(null);
      const w = await buildWorld(prisma, { suffix: '_wallet' });
      const start = Math.floor((Date.now() - DAY) / 1000);
      const end = Math.floor((Date.now() + 29 * DAY) / 1000);
      await prisma.subscription.update({ where: { id: w.sub.id }, data: { currentPeriodStart: new Date(start * 1000), currentPeriodEnd: new Date(end * 1000) } });
      const jwt = await login(w.member.email, w.member.password);
      const serial = (await extractPassJsonFromPkpass(await downloadApplePass(w.studio.id, jwt))).serialNumber as string;
      await dynamic.enroll(serial);
      expect(await statusOf(serial)).toBe('VIGENTE');
      await registerDevice(serial, (await passOf(serial)).authenticationToken!, 'device-stripe', 'cd'.repeat(32));
      await settle();

      const say = (status: string) =>
        stripe['retrieveSubscription']?.mockResolvedValue({ id: w.stripeSubscriptionId, object: 'subscription', status, cancellation_details: { reason: null }, metadata: {}, items: { data: [] } });
      say('past_due');
      await signedPost(app, webhookSecret, w.subscriptionEvent({ type: 'customer.subscription.updated', status: 'past_due', periodStart: start, periodEnd: end, created: w.nowUnix() })).expect(200);
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: w.sub.id } })).status).toBe(SubscriptionStatus.PAST_DUE);
      const failed = await detectAndProcess();
      expect(failed.jobs).toEqual([expect.objectContaining({ result: 'SUCCEEDED', outcome: `${serial}:updated:pushed:1` })]);
      expect(await statusOf(serial)).toBe('PAGO PENDIENTE');

      say('active');
      await signedPost(app, webhookSecret, w.subscriptionEvent({ type: 'customer.subscription.updated', status: 'active', periodStart: start, periodEnd: end, created: w.nowUnix() + 5 })).expect(200);
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: w.sub.id } })).status).toBe(SubscriptionStatus.ACTIVE);
      const recovered = await detectAndProcess();
      expect(recovered.jobs).toEqual([expect.objectContaining({ result: 'SUCCEEDED', outcome: `${serial}:updated:pushed:1` })]);
      expect(await statusOf(serial)).toBe('VIGENTE');
      expect(await artifactOf(serial)).toMatchObject({ passVersion: 3, pushedPassVersion: 3 });
      expect(apns.received).toHaveLength(2);
    });

    it('Stripe renewal arriving after the period boundary: VENCIDA -> VIGENTE with the new end date', async () => {
      stripe['listSubscriptionsForCustomer']?.mockResolvedValue([]);
      stripe['findPaidInvoicePaymentIntentId']?.mockResolvedValue(null);
      stripe['retrieveSubscription']?.mockResolvedValue({ id: 'sub_fx_full_renew', object: 'subscription', status: 'active', cancellation_details: { reason: null }, metadata: {}, items: { data: [] } });
      const w = await buildWorld(prisma, { suffix: '_renew' });
      const oldEnd = Math.floor((Date.now() - 60_000) / 1000); // the period just ended; Stripe's renewal is in flight
      await prisma.subscription.update({ where: { id: w.sub.id }, data: { currentPeriodStart: new Date((oldEnd - 30 * 86_400) * 1000), currentPeriodEnd: new Date(oldEnd * 1000) } });
      const jwt = await login(w.member.email, w.member.password);
      const serial = (await extractPassJsonFromPkpass(await downloadApplePass(w.studio.id, jwt))).serialNumber as string;
      await dynamic.enroll(serial);
      expect(await statusOf(serial)).toBe('VENCIDA');
      await registerDevice(serial, (await passOf(serial)).authenticationToken!, 'device-renew', 'fe'.repeat(32));
      await settle();

      const newEnd = oldEnd + 30 * 86_400;
      await signedPost(app, webhookSecret, w.subscriptionEvent({ type: 'customer.subscription.updated', status: 'active', periodStart: oldEnd, periodEnd: newEnd, created: w.nowUnix() })).expect(200);
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: w.sub.id } })).currentPeriodEnd).toEqual(new Date(newEnd * 1000));
      const { jobs } = await detectAndProcess();
      expect(jobs).toEqual([expect.objectContaining({ result: 'SUCCEEDED', outcome: `${serial}:updated:pushed:1` })]);
      expect(await statusOf(serial)).toBe('VIGENTE');
      expect(await validityOf(serial)).toContain(formatInstantDateEs(new Date(newEnd * 1000), TZ));
      expect((await artifactOf(serial)).nextTransitionAt).toEqual(new Date(newEnd * 1000));
    });

    it('plan definition change (rename by the owner) reaches every holder of that plan', async () => {
      const m = await dynamicMember('plan-rename', async (studioId, userId) => {
        const p = await plan(studioId);
        await cash(studioId, userId, p.id, new Date(Date.now() - DAY), new Date(Date.now() + 29 * DAY));
      });
      expect(await planOf(m.serial)).toBe('Full Access');
      await settle();
      const owner = await createUserWithPassword(prisma);
      await createMembership(prisma, owner.id, m.studioId, Role.OWNER);
      const planRow = await prisma.membershipPlan.findFirstOrThrow({ where: { studioId: m.studioId } });
      await request(app.getHttpServer())
        .patch(`/api/v1/studios/${m.studioId}/membership-plans/${planRow.id}`)
        .set('Authorization', `Bearer ${await login(owner.email, owner.password)}`)
        .send({ name: 'Full Access Plus' })
        .expect(200);

      const { jobs } = await detectAndProcess();
      expect(jobs).toEqual([expect.objectContaining({ result: 'SUCCEEDED', outcome: `${m.serial}:updated:no_registrations` })]);
      expect(await planOf(m.serial)).toBe('Full Access Plus');
    });

    it('member switches plan (new cash sale in the same group supersedes the old one)', async () => {
      const m = await dynamicMember('plan-switch', async (studioId, userId) => {
        const basic = await plan(studioId, { name: 'Basic' });
        await cash(studioId, userId, basic.id, new Date(Date.now() - DAY), new Date(Date.now() + 29 * DAY));
      });
      expect(await planOf(m.serial)).toBe('Basic');
      const full = await plan(m.studioId, { name: 'Full Access' });
      await settle();
      const owner = await createUserWithPassword(prisma);
      await createMembership(prisma, owner.id, m.studioId, Role.OWNER);
      await request(app.getHttpServer())
        .post(`/api/v1/studios/${m.studioId}/members/${m.member.id}/offline-subscriptions`)
        .set('Authorization', `Bearer ${await login(owner.email, owner.password)}`)
        .send({ planId: full.id, amountCents: 120000, paymentMethod: 'CASH' })
        .expect(201);

      await detectAndProcess();
      expect(await planOf(m.serial)).toBe('Full Access');
      expect(await statusOf(m.serial)).toBe('VIGENTE');
    });

    it('credential reissue: the old dynamic pass becomes REEMPLAZADO (voided) and is pushed; the new static pass is untouched', async () => {
      const m = await dynamicMember('reissue', async (studioId, userId) => {
        const p = await plan(studioId);
        await cash(studioId, userId, p.id, new Date(Date.now() - DAY), new Date(Date.now() + 29 * DAY));
      });
      await registerDevice(m.serial, m.token, 'device-reissue', 'ef'.repeat(32));
      await settle();
      await request(app.getHttpServer()).post(`/api/v1/studios/${m.studioId}/wallet/reissue`).set('Authorization', `Bearer ${m.jwt}`).expect(200);
      const fresh = await prisma.walletCredential.findFirstOrThrow({ where: { studioId: m.studioId, userId: m.member.id, revokedAt: null } });
      expect(fresh.id).not.toBe(m.serial);
      const freshArtifactBefore = await artifactOf(fresh.id);
      expect(freshArtifactBefore.passMode).toBe(WalletPassMode.STATIC);

      const { jobs } = await detectAndProcess();
      expect(jobs).toEqual([expect.objectContaining({ result: 'SUCCEEDED', outcome: `${m.serial}:updated:pushed:1` })]);
      const old = await passOf(m.serial);
      expect(old.voided).toBe(true);
      expect(old.generic.headerFields[0]!.value).toBe('REEMPLAZADO');
      expect(old.barcodes[0]!.message).toBe(m.barcode);
      expect(await artifactOf(fresh.id)).toEqual(freshArtifactBefore);
    });

    it('tenant isolation: a change in one studio refreshes only that studio\'s pass for a member of two studios', async () => {
      const a = await dynamicMember('tenant', async (studioId, userId) => {
        const p = await plan(studioId);
        await cash(studioId, userId, p.id, new Date(Date.now() - DAY), new Date(Date.now() + 29 * DAY));
      });
      const studioB = await createStudio(prisma, { timezone: TZ });
      await createMembership(prisma, a.member.id, studioB.id, Role.MEMBER);
      const pB = await plan(studioB.id);
      await cash(studioB.id, a.member.id, pB.id, new Date(Date.now() - DAY), new Date(Date.now() + 29 * DAY));
      const serialB = (await extractPassJsonFromPkpass(await downloadApplePass(studioB.id, a.jwt))).serialNumber as string;
      await dynamic.enroll(serialB);
      await settle();
      const bBefore = await artifactOf(serialB);

      await prisma.subscription.updateMany({ where: { studioId: a.studioId, userId: a.member.id }, data: { currentPeriodEnd: new Date(Date.now() + 9 * DAY) } });
      const { detection, jobs } = await detectAndProcess();
      expect(detection.enqueued).toBe(1);
      expect(jobs).toEqual([expect.objectContaining({ studioId: a.studioId, result: 'SUCCEEDED', outcome: `${a.serial}:updated:no_registrations` })]);
      expect(await artifactOf(serialB)).toEqual(bBefore);
      expect(await jobsOf(studioB.id, a.member.id)).toEqual([]);
    });
  });

  describe('time boundaries (transition sweep with an injected clock)', () => {
    it('cash period ends: enqueued for the boundary, not processed early, VIGENTE -> VENCIDA right after it, then quiet', async () => {
      const end = new Date(Date.now() + 2 * MIN);
      const m = await dynamicMember('expiry', async (studioId, userId) => {
        const p = await plan(studioId);
        await cash(studioId, userId, p.id, new Date(Date.now() - 29 * DAY), end);
      });
      expect(m.artifact.nextTransitionAt).toEqual(end);
      await registerDevice(m.serial, m.token, 'device-expiry', 'aa'.repeat(32));

      const now = new Date();
      expect(await triggers.sweepTransitions(now)).toEqual({ skipped: false, enqueued: 1 });
      const [job] = await jobsOf(m.studioId, m.member.id);
      expect(job).toMatchObject({ status: WalletPassRefreshStatus.PENDING, reason: 'TIME_TRANSITION', runAfter: new Date(end.getTime() + 1000) });
      expect(await worker.processDue(now)).toEqual([]);

      const after = new Date(end.getTime() + 2000);
      const jobs = await worker.processDue(after);
      expect(jobs).toEqual([expect.objectContaining({ result: 'SUCCEEDED', outcome: `${m.serial}:updated:pushed:1` })]);
      expect(await statusOf(m.serial)).toBe('VENCIDA');
      expect((await artifactOf(m.serial)).nextTransitionAt).toBeNull();
      expect(await triggers.sweepTransitions(new Date(end.getTime() + 5 * MIN))).toEqual({ skipped: false, enqueued: 0 });
      expect(apns.received).toHaveLength(1);
    });

    it('fixed-duration entitlement (Booty Lab style): the boundary is entitlementEndsAt, not the billing period end', async () => {
      const entitlementEnd = new Date(Date.now() + 2 * MIN);
      const m = await dynamicMember('entitlement-boundary', async (studioId, userId) => {
        const booty = await plan(studioId, { name: 'Booty Lab', exclusiveGroup: null, entitlementDays: 45 });
        await prisma.subscription.create({
          data: {
            studioId, userId, membershipPlanId: booty.id, status: SubscriptionStatus.ACTIVE, source: SubscriptionSource.STRIPE,
            stripeSubscriptionId: 'sub_wallet_booty_boundary', currentPeriodStart: new Date(Date.now() - 14 * DAY),
            currentPeriodEnd: new Date(Date.now() + 16 * DAY), entitlementEndsAt: entitlementEnd, exclusiveGroupKey: null,
          },
        });
      });
      expect(await statusOf(m.serial)).toBe('VIGENTE');
      expect(m.artifact.nextTransitionAt).toEqual(entitlementEnd);
      await triggers.sweepTransitions(new Date());
      expect(await worker.processDue(new Date(entitlementEnd.getTime() - 1000))).toEqual([]);
      await worker.processDue(new Date(entitlementEnd.getTime() + 2000));
      expect(await statusOf(m.serial)).toBe('VENCIDA');
    });

    it('scheduled activation: PROGRAMADA -> VIGENTE at the start instant', async () => {
      const start = new Date(Date.now() + 3 * MIN);
      const m = await dynamicMember('scheduled', async (studioId, userId) => {
        const p = await plan(studioId);
        await cash(studioId, userId, p.id, start, new Date(start.getTime() + 30 * DAY));
      });
      expect(await statusOf(m.serial)).toBe('PROGRAMADA');
      expect(m.artifact.nextTransitionAt).toEqual(start);
      await triggers.sweepTransitions(new Date());
      await worker.processDue(new Date(start.getTime() + 2000));
      expect(await statusOf(m.serial)).toBe('VIGENTE');
      expect((await artifactOf(m.serial)).nextTransitionAt).toEqual(new Date(start.getTime() + 30 * DAY));
    });

    it('day pass: PASE DE DÍA today, no longer valid right after studio-local midnight', async () => {
      const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const anchor = new Date(`${todayKey}T06:00:00.000Z`); // Mexico City is UTC-6 year-round
      const midnight = new Date(anchor.getTime() + DAY);
      const m = await dynamicMember('day-pass', (studioId, userId) =>
        prisma.dayPass.create({ data: { studioId, userId, validForDate: anchor, priceCents: 20000, status: DayPassStatus.ACTIVE } }),
      );
      expect(await statusOf(m.serial)).toBe('PASE DE DÍA');
      expect(m.artifact.nextTransitionAt).toEqual(midnight);

      expect((await triggers.sweepTransitions(new Date(midnight.getTime() - MIN))).enqueued).toBe(1);
      expect(await worker.processDue(new Date(midnight.getTime() - 30_000))).toEqual([]);
      await worker.processDue(new Date(midnight.getTime() + 2000));
      expect(await statusOf(m.serial)).not.toBe('PASE DE DÍA');
      expect((await artifactOf(m.serial)).passVersion).toBe(2);
    });

    it('multiple memberships: when Full Access ends the pass falls back to the remaining Booty Lab membership', async () => {
      const fullEnd = new Date(Date.now() + 2 * MIN);
      const bootyEnd = new Date(Date.now() + 20 * DAY);
      const m = await dynamicMember('multi', async (studioId, userId) => {
        const full = await plan(studioId, { name: 'Full Access' });
        const booty = await plan(studioId, { name: 'Booty Lab', exclusiveGroup: null, entitlementDays: 45 });
        await cash(studioId, userId, full.id, new Date(Date.now() - 29 * DAY), fullEnd);
        await cash(studioId, userId, booty.id, new Date(Date.now() - 25 * DAY), bootyEnd, null);
      });
      expect(await statusOf(m.serial)).toBe('VIGENTE');
      expect(m.artifact.nextTransitionAt).toEqual(fullEnd);

      await triggers.sweepTransitions(new Date());
      await worker.processDue(new Date(fullEnd.getTime() + 2000));
      expect(await statusOf(m.serial)).toBe('VIGENTE');
      expect(await planOf(m.serial)).toBe('Booty Lab');
      expect((await artifactOf(m.serial)).nextTransitionAt).toEqual(bootyEnd);
    });
  });

  describe('durable queue', () => {
    async function twoMembers() {
      const studio = await createStudio(prisma);
      const u1 = await createUserWithPassword(prisma);
      const u2 = await createUserWithPassword(prisma);
      return { studioId: studio.id, u1: u1.id, u2: u2.id };
    }

    it('enqueue coalesces per member: one PENDING row, earliest runAfter wins, triggers are counted', async () => {
      const { studioId, u1, u2 } = await twoMembers();
      const now = new Date();
      await queue.enqueue([{ studioId, userId: u1, runAfter: new Date(now.getTime() + 10 * MIN) }], 'TIME_TRANSITION', { now });
      await queue.enqueue([{ studioId, userId: u1, runAfter: new Date(now.getTime() + 2 * MIN) }], 'TIME_TRANSITION', { now });
      await queue.enqueue([{ studioId, userId: u1 }, { studioId, userId: u2 }], 'CHANGE_DETECTED', { now });
      const rows = await prisma.walletPassRefreshJob.findMany({ orderBy: { userId: 'asc' } });
      expect(rows).toHaveLength(2);
      const r1 = rows.find((r) => r.userId === u1)!;
      expect(r1).toMatchObject({ status: WalletPassRefreshStatus.PENDING, triggerCount: 3, reason: 'TIME_TRANSITION' });
      expect(r1.runAfter.getTime()).toBe(now.getTime());
    });

    it('concurrent claims never hand out the same job; a member with a live RUNNING job is not claimed again', async () => {
      const { studioId, u1, u2 } = await twoMembers();
      const now = new Date();
      await queue.enqueue([{ studioId, userId: u1 }, { studioId, userId: u2 }], 'MANUAL', { now });
      const [a, b] = await Promise.all([queue.claim('worker-a', now, 10), queue.claim('worker-b', now, 10)]);
      const ids = [...a, ...b].map((j) => j.id);
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);

      // A new change for u1 while its job is RUNNING: a second PENDING row exists but waits.
      await queue.enqueue([{ studioId, userId: u1 }], 'CHANGE_DETECTED', { now });
      expect(await prisma.walletPassRefreshJob.count({ where: { userId: u1 } })).toBe(2);
      expect(await queue.claim('worker-c', now, 10)).toEqual([]);
      const holder = a.some((j) => j.userId === u1) ? 'worker-a' : 'worker-b';
      const running = [...a, ...b].find((j) => j.userId === u1)!;
      expect(await queue.complete(running, holder, 'done', now)).toBe(true);
      expect((await queue.claim('worker-c', now, 10)).map((j) => j.userId)).toEqual([u1]);
    });

    it('crash recovery: an expired lease is re-queued and finished by another worker; the stale worker cannot overwrite it', async () => {
      const m = await dynamicMember('lease', async (studioId, userId) => {
        const p = await plan(studioId);
        await cash(studioId, userId, p.id, new Date(Date.now() - DAY), new Date(Date.now() + 29 * DAY));
      });
      const now = new Date();
      await queue.enqueue([{ studioId: m.studioId, userId: m.member.id }], 'MANUAL', { now });
      const [stale] = await queue.claim('crashed-worker', now, 1);
      expect(stale).toBeDefined();

      const later = new Date(now.getTime() + WALLET_REFRESH_LEASE_MS + 1000);
      expect(await queue.recoverExpiredLeases(new Date(now.getTime() + 1000))).toEqual({ requeued: 0, superseded: 0, failed: 0 });
      expect(await queue.recoverExpiredLeases(later)).toEqual({ requeued: 1, superseded: 0, failed: 0 });
      const jobs = await worker.processDue(later);
      expect(jobs).toEqual([expect.objectContaining({ result: 'SUCCEEDED' })]);
      expect(await queue.complete(stale!, 'crashed-worker', 'late', later)).toBe(false);
      const [row] = await jobsOf(m.studioId, m.member.id);
      expect(row).toMatchObject({ status: WalletPassRefreshStatus.SUCCEEDED, attempts: 2, lockedBy: null });
    });

    it('a retry that collides with a newer PENDING row is SUPERSEDED (the pending row recomputes anyway)', async () => {
      const { studioId, u1 } = await twoMembers();
      const now = new Date();
      await queue.enqueue([{ studioId, userId: u1 }], 'MANUAL', { now });
      const [job] = await queue.claim('w1', now, 1);
      await queue.enqueue([{ studioId, userId: u1 }], 'CHANGE_DETECTED', { now });
      expect(await queue.retryOrFail(job!, 'w1', new Error('transient'), now)).toBe('SUPERSEDED');
      const rows = await prisma.walletPassRefreshJob.findMany({ orderBy: { createdAt: 'asc' } });
      expect(rows.map((r) => r.status)).toEqual([WalletPassRefreshStatus.SUPERSEDED, WalletPassRefreshStatus.PENDING]);
    });

    it('poison job: an integrity failure dead-letters at once, never rotates the token, and is left alone during the cooldown', async () => {
      const m = await dynamicMember('poison', async (studioId, userId) => {
        const p = await plan(studioId);
        await cash(studioId, userId, p.id, new Date(Date.now() - DAY), new Date(Date.now() + 29 * DAY));
      });
      await prisma.subscription.updateMany({ where: { userId: m.member.id }, data: { currentPeriodEnd: new Date(Date.now() + 9 * DAY) } });
      await prisma.walletPassArtifact.update({ where: { id: m.artifact.id }, data: { authenticationTokenHash: hashPassAuthenticationToken('x'.repeat(43)) } });

      const now = new Date();
      await queue.enqueue([{ studioId: m.studioId, userId: m.member.id }], 'MANUAL', { now });
      expect(await worker.processDue(now)).toEqual([expect.objectContaining({ result: 'FAILED', outcome: 'WALLET_DYNAMIC_TOKEN_UNRECOVERABLE' })]);
      const row = await artifactOf(m.serial);
      expect(row.passVersion).toBe(1);
      expect(Buffer.from(row.pkpassData!).equals(Buffer.from(m.artifact.pkpassData!))).toBe(true);
      expect((await jobsOf(m.studioId, m.member.id))[0]).toMatchObject({ status: WalletPassRefreshStatus.FAILED, attempts: 1, lastError: 'WALLET_DYNAMIC_TOKEN_UNRECOVERABLE' });

      expect((await triggers.reconcileAll(new Date(now.getTime() + MIN))).enqueued).toBe(0);
      expect((await triggers.reconcileAll(new Date(now.getTime() + WALLET_REFRESH_DEAD_LETTER_COOLDOWN_MS + MIN))).enqueued).toBe(1);
      expect((await queue.stats(new Date(now.getTime() + MIN))).failedLast24h).toEqual([{ lastError: 'WALLET_DYNAMIC_TOKEN_UNRECOVERABLE', count: 1 }]);
    });
  });

  describe('APNs delivery', () => {
    async function changedMember(prefix: string, pushToken: string) {
      const m = await dynamicMember(prefix, async (studioId, userId) => {
        const p = await plan(studioId);
        await cash(studioId, userId, p.id, new Date(Date.now() - DAY), new Date(Date.now() + 29 * DAY));
      });
      await registerDevice(m.serial, m.token, `device-${prefix}`, pushToken);
      await prisma.subscription.updateMany({ where: { userId: m.member.id }, data: { currentPeriodEnd: new Date(Date.now() + 9 * DAY) } });
      await queue.enqueue([{ studioId: m.studioId, userId: m.member.id }], 'MANUAL');
      return m;
    }

    it('a transient APNs failure retries with backoff; the retry re-pushes without re-signing', async () => {
      let calls = 0;
      apns.reply = () => (++calls === 1 ? { status: 503, reason: 'ServiceUnavailable' } : { status: 200 });
      const m = await changedMember('apns-503', '11'.repeat(32));
      const now = new Date();
      expect(await worker.processDue(now)).toEqual([expect.objectContaining({ result: 'RETRY', outcome: expect.stringContaining('APNS_TRANSIENT:503:ServiceUnavailable') })]);
      let art = await artifactOf(m.serial);
      expect(art).toMatchObject({ passVersion: 2, pushedPassVersion: 1 });
      const [pending] = await jobsOf(m.studioId, m.member.id);
      const delay = pending!.runAfter.getTime() - now.getTime();
      expect(delay).toBeGreaterThanOrEqual(24_000);
      expect(delay).toBeLessThanOrEqual(36_000);
      expect(await worker.processDue(new Date(now.getTime() + 10_000))).toEqual([]);

      expect(await worker.processDue(new Date(now.getTime() + 40_000))).toEqual([
        expect.objectContaining({ result: 'SUCCEEDED', outcome: `${m.serial}:unchanged:pushed:1` }),
      ]);
      art = await artifactOf(m.serial);
      expect(art).toMatchObject({ passVersion: 2, pushedPassVersion: 2 });
      expect(apns.received).toHaveLength(2);
    });

    it('a persistently failing push dead-letters after the maximum attempts', async () => {
      apns.reply = () => ({ status: 503, reason: 'ServiceUnavailable' });
      const m = await changedMember('apns-dead', '22'.repeat(32));
      let t = Date.now();
      const results: string[] = [];
      for (let i = 0; i < WALLET_REFRESH_MAX_ATTEMPTS; i += 1) {
        const [r] = await worker.processDue(new Date(t));
        results.push(r!.result);
        const [row] = await jobsOf(m.studioId, m.member.id);
        t = row!.runAfter.getTime() + 1000;
      }
      expect(results).toEqual([...Array(WALLET_REFRESH_MAX_ATTEMPTS - 1).fill('RETRY'), 'FAILED']);
      expect((await jobsOf(m.studioId, m.member.id))[0]).toMatchObject({ status: WalletPassRefreshStatus.FAILED, attempts: WALLET_REFRESH_MAX_ATTEMPTS });
      expect((await artifactOf(m.serial)).pushedPassVersion).toBe(1);
    });

    it('410 Unregistered prunes the registration, counts as delivered bookkeeping, and is not retried', async () => {
      apns.reply = () => ({ status: 410, reason: 'Unregistered' });
      const m = await changedMember('apns-410', '33'.repeat(32));
      expect(await worker.processDue(new Date())).toEqual([expect.objectContaining({ result: 'SUCCEEDED', outcome: `${m.serial}:updated:pushed:0` })]);
      expect(await prisma.walletPassRegistration.count()).toBe(0);
      expect(await artifactOf(m.serial)).toMatchObject({ passVersion: 2, pushedPassVersion: 2 });
    });

    it('with APNs disabled the version stays undelivered and the next reconciliation pushes it once enabled', async () => {
      const m = await changedMember('apns-off', '44'.repeat(32));
      const off = jest.spyOn(pushes, 'isEnabled').mockReturnValue(false);
      try {
        expect(await worker.processDue(new Date())).toEqual([expect.objectContaining({ result: 'SUCCEEDED', outcome: `${m.serial}:updated:push_pending_apns_disabled` })]);
      } finally {
        off.mockRestore();
      }
      expect(apns.received).toHaveLength(0);
      expect(await artifactOf(m.serial)).toMatchObject({ passVersion: 2, pushedPassVersion: 1 });

      await triggers.reconcileAll(new Date());
      expect(await worker.processDue(new Date())).toEqual([expect.objectContaining({ outcome: `${m.serial}:unchanged:pushed:1` })]);
      expect(await artifactOf(m.serial)).toMatchObject({ passVersion: 2, pushedPassVersion: 2 });

      // Unchanged content is never pushed again.
      await triggers.reconcileAll(new Date());
      expect(await worker.processDue(new Date())).toEqual([expect.objectContaining({ outcome: `${m.serial}:unchanged:no_push_needed` })]);
      expect(apns.received).toHaveLength(1);
    });
  });

  describe('safety', () => {
    it('a full forced worker cycle changes no financial, membership or credential record', async () => {
      const m = await dynamicMember('no-financial', async (studioId, userId) => {
        const p = await plan(studioId);
        await cash(studioId, userId, p.id, new Date(Date.now() - 34 * DAY), new Date(Date.now() - 4 * DAY));
      });
      const owner = await createUserWithPassword(prisma);
      await createMembership(prisma, owner.id, m.studioId, Role.OWNER);
      const planRow = await prisma.membershipPlan.findFirstOrThrow({ where: { studioId: m.studioId } });
      await request(app.getHttpServer())
        .post(`/api/v1/studios/${m.studioId}/members/${m.member.id}/offline-subscriptions`)
        .set('Authorization', `Bearer ${await login(owner.email, owner.password)}`)
        .send({ planId: planRow.id, amountCents: 120000, paymentMethod: 'CASH' })
        .expect(201);
      expect(await prisma.payment.count()).toBeGreaterThan(0);

      const tables = ['payments', 'subscriptions', 'membership_entitlement_cycles', 'day_passes', 'wallet_credentials', 'studio_memberships', 'membership_plans', 'users', 'studios', 'attendances', 'bookings'];
      const before = await Promise.all(tables.map(checksum));
      await worker.runOnce(new Date(), { force: true });
      await worker.runOnce(new Date(Date.now() + 2 * DAY), { force: true });
      expect(await Promise.all(tables.map(checksum))).toEqual(before);
      expect(await statusOf(m.serial)).toBe('VIGENTE');
    });

    it('existing check-in is unaffected: the refreshed dynamic pass QR still checks the member into a booked class', async () => {
      const m = await dynamicMember('checkin', async (studioId, userId) => {
        const p = await plan(studioId);
        await cash(studioId, userId, p.id, new Date(Date.now() - DAY), new Date(Date.now() + 29 * DAY));
      });
      await prisma.subscription.updateMany({ where: { userId: m.member.id }, data: { currentPeriodEnd: new Date(Date.now() + 9 * DAY) } });
      await queue.enqueue([{ studioId: m.studioId, userId: m.member.id }], 'MANUAL');
      await worker.processDue(new Date());
      const pass = await passOf(m.serial);
      expect((await artifactOf(m.serial)).passVersion).toBe(2);
      expect(pass.barcodes[0]!.message).toBe(m.barcode);

      const tpl = await createClassTemplate(prisma, m.studioId);
      const startsAt = new Date(Date.now() + 10 * MIN);
      const cls = await createScheduledClass(prisma, m.studioId, tpl.id, { startsAt, endsAt: new Date(startsAt.getTime() + 60 * MIN) });
      await createConfirmedBooking(prisma, m.studioId, cls.id, m.member.id);
      const staff = await createUserWithPassword(prisma);
      await createMembership(prisma, staff.id, m.studioId, Role.STAFF);
      const res = await request(app.getHttpServer())
        .post(`/api/v1/studios/${m.studioId}/check-ins/qr`)
        .set('Authorization', `Bearer ${await login(staff.email, staff.password)}`)
        .send({ qrToken: pass.barcodes[0]!.message })
        .expect(201);
      expect((res.body as { userId: string }).userId).toBe(m.member.id);
    });

    it('scheduling phases are single-flight across instances (advisory lock held elsewhere -> skipped)', async () => {
      await dynamicMember('lock');
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('wallet_refresh:reconcile'))`;
        expect(await triggers.reconcileAll(new Date())).toEqual({ skipped: true, enqueued: 0, members: 0 });
        expect((await triggers.detectChanges(new Date())).skipped).toBe(false); // other phases use other keys
      });
      expect(await triggers.reconcileAll(new Date())).toMatchObject({ skipped: false, members: 1 });
      expect(await prisma.walletPassRefreshJob.count()).toBe(1);
    });
  });
});
