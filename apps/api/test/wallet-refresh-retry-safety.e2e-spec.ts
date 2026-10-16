// Must stay the first import: sets the Smart Wallet env before AppModule is imported.
import './helpers/wallet-dynamic-env.on';
import * as http2 from 'node:http2';
import http2Module from 'node:http2';
import type { INestApplication } from '@nestjs/common';
import { Role, SubscriptionSource, SubscriptionStatus, WalletPassPlatform, WalletPassRefreshStatus } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { formatInstantDateEs } from '../src/wallet/access/wallet-access-display';
import { extractPassJsonFromPkpass } from '../src/wallet/apple/pkpass-reader';
import { WalletDynamicPassService } from '../src/wallet/dynamic/wallet-dynamic-pass.service';
import { ApnsClientFactory, type ApnsClientOptions } from '../src/wallet/passkit/apns.client';
import {
  WALLET_REFRESH_CHANGE_CURSOR,
  WALLET_REFRESH_CHANGE_OVERLAP_MS,
  WALLET_REFRESH_CHANGE_POLL_MS,
  WALLET_REFRESH_DEAD_LETTER_COOLDOWN_MS,
  WALLET_REFRESH_LEASE_MS,
  WALLET_REFRESH_MAX_ATTEMPTS,
} from '../src/wallet/refresh/wallet-refresh.constants';
import { WalletRefreshQueueService } from '../src/wallet/refresh/wallet-refresh-queue.service';
import { WalletRefreshTriggersService } from '../src/wallet/refresh/wallet-refresh-triggers.service';
import { WalletRefreshWorkerService } from '../src/wallet/refresh/wallet-refresh-worker.service';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import { FakeApns } from './helpers/fake-apns';
import { createMembership, createStudio, createUserWithPassword } from './helpers/factories';
import { appleFixture, DYNAMIC_PASS_TYPE } from './helpers/wallet-dynamic-env';

/**
 * Smart Wallet 2.0 Stage 4A.1 — retry safety of the refresh queue under repeated triggers.
 *
 * Regression for the Stage 4A staging finding: change detection re-scans 120 s behind its cursor,
 * so one committed change is detected on every 15 s poll for two minutes. Each detection used to
 * pull a backed-off retry forward to "now", and a transient APNs outage exhausted all six attempts
 * in 75 s. Every test runs on a fake clock against the isolated test database; APNs is a LOCAL
 * HTTP/2 server and any attempt to reach Apple fails the suite.
 */
const TZ = 'America/Mexico_City';
const SEC = 1000;
const MIN = 60 * SEC;
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

const maybeDescribe = appleFixture ? describe : describe.skip;

maybeDescribe('Smart Wallet 2.0 Stage 4A.1 — refresh retry safety (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let dynamic: WalletDynamicPassService;
  let queue: WalletRefreshQueueService;
  let triggers: WalletRefreshTriggersService;
  let worker: WalletRefreshWorkerService;
  const apns = new FakeApns(Buffer.from(appleFixture?.wwdrPemBase64 ?? '', 'base64').toString('utf8'));
  let jitter: jest.SpyInstance | null = null;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    dynamic = app.get(WalletDynamicPassService);
    queue = app.get(WalletRefreshQueueService);
    triggers = app.get(WalletRefreshTriggersService);
    worker = app.get(WalletRefreshWorkerService);
    await apns.start();
    const factory = app.get(ApnsClientFactory);
    const create = factory.create.bind(factory);
    jest.spyOn(factory, 'create').mockImplementation((options: ApnsClientOptions) => create({ ...options, host: apns.host, ca: apns.certPem }));
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    apns.reset();
  });

  afterEach(() => {
    jitter?.mockRestore();
    jitter = null;
  });

  afterAll(async () => {
    await apns.stop();
    await app.close();
  });

  // --- helpers ---------------------------------------------------------------------------------

  /** Backoff jitter is ±20 %; pinning Math.random to 0.5 makes it exactly 1.0 (30 s, 60 s, 2, 4, 8 min). */
  function exactBackoff(): void {
    jitter = jest.spyOn(Math, 'random').mockReturnValue(0.5);
  }

  async function login(email: string, password: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password }).expect(201);
    return (res.body as { accessToken: string }).accessToken;
  }

  /** A member with an active cash period, a DYNAMIC pass and one registered device. */
  async function dynamicMemberWithDevice(prefix: string) {
    const studio = await createStudio(prisma, { timezone: TZ });
    const member = await createUserWithPassword(prisma, { email: `${prefix}-${Math.random().toString(36).slice(2, 8)}@e2e.local` });
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    const p = await prisma.membershipPlan.create({
      data: { studioId: studio.id, name: 'Full Access', priceCents: 120000, currency: 'mxn', billingInterval: 'MONTHLY', active: true, allClassesAccess: true, openGymAccess: true, exclusiveGroup: 'CORE' },
    });
    await prisma.subscription.create({
      data: {
        studioId: studio.id, userId: member.id, membershipPlanId: p.id, status: SubscriptionStatus.ACTIVE, source: SubscriptionSource.CASH,
        currentPeriodStart: new Date(Date.now() - DAY), currentPeriodEnd: new Date(Date.now() + 29 * DAY), cancelAtPeriodEnd: true, exclusiveGroupKey: 'CORE',
      },
    });
    const jwt = await login(member.email, member.password);
    const res = await request(app.getHttpServer()).post(`/api/v1/studios/${studio.id}/wallet/apple`).set('Authorization', `Bearer ${jwt}`).buffer(true).parse(binaryParser).expect(200);
    const serial = (await extractPassJsonFromPkpass(res.body as Buffer)).serialNumber as string;
    await dynamic.enroll(serial);
    const token = (await passOf(serial)).authenticationToken;
    await request(app.getHttpServer())
      .post(`${PASSKIT}/devices/device-${prefix}/registrations/${DYNAMIC_PASS_TYPE}/${serial}`)
      .set('Authorization', `ApplePass ${token}`)
      .send({ pushToken: 'ab'.repeat(32) })
      .expect(201);
    return { studioId: studio.id, userId: member.id, serial };
  }

  /** Two bare members for queue-level tests (no pass needed). */
  async function bareMembers() {
    const studio = await createStudio(prisma);
    const u1 = await createUserWithPassword(prisma);
    const u2 = await createUserWithPassword(prisma);
    return { studioId: studio.id, u1: u1.id, u2: u2.id };
  }

  function artifactOf(serial: string) {
    return prisma.walletPassArtifact.findUniqueOrThrow({ where: { walletCredentialId_platform: { walletCredentialId: serial, platform: WalletPassPlatform.APPLE } } });
  }

  async function passOf(serial: string) {
    return (await extractPassJsonFromPkpass(Buffer.from((await artifactOf(serial)).pkpassData!))) as unknown as {
      authenticationToken: string;
      generic: { secondaryFields: Array<{ key: string; value: string }> };
    };
  }

  /** Everything created so far looks old to the detector, and its cursor moves to `now`. */
  async function settle(now: Date) {
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

  /** One committed entitlement change, exactly like the staging `set-entitlement` command. */
  async function changeEntitlement(userId: string, end: Date) {
    await prisma.subscription.updateMany({ where: { userId }, data: { currentPeriodEnd: end } });
  }

  const jobsOf = (userId: string) => prisma.walletPassRefreshJob.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  const pendingOf = (userId: string) => prisma.walletPassRefreshJob.findMany({ where: { userId, status: WalletPassRefreshStatus.PENDING } });

  // --- the staging finding ----------------------------------------------------------------------

  it('repeated change detection during an APNs outage keeps the backoff schedule (Stage 4A staging finding)', async () => {
    const m = await dynamicMemberWithDevice('outage');
    apns.reply = () => ({ status: 503, reason: 'ServiceUnavailable' });
    await settle(new Date());
    await changeEntitlement(m.userId, new Date(Date.now() + 9 * DAY));
    exactBackoff();

    const t0 = Date.now() + SEC;
    const attemptsAt: number[] = [];
    let detected = 0;
    // The worker's cadences on a fake clock: change detection every 15 s, then due jobs.
    for (let s = 0; s <= 20 * 60; s += WALLET_REFRESH_CHANGE_POLL_MS / SEC) {
      const now = new Date(t0 + s * SEC);
      detected += (await triggers.detectChanges(now)).enqueued;
      const scheduled = (await pendingOf(m.userId))[0]?.runAfter ?? null;
      const ran = await worker.processDue(now, 50);
      if (ran.length > 0) {
        attemptsAt.push(...ran.map(() => s));
        expect(scheduled).not.toBeNull();
        expect(scheduled!.getTime()).toBeLessThanOrEqual(now.getTime()); // never before its scheduled time
      }
      expect((await pendingOf(m.userId)).length).toBeLessThanOrEqual(1); // one PENDING job per member
      if (ran.some((r) => r.result === 'FAILED')) break;
    }

    // The attempts follow the documented backoff (30 s, 60 s, 2 min, 4 min, 8 min), not the polls.
    // Before the fix: [0, 15, 30, 45, 60, 75] — all six attempts inside the overlap window.
    expect(attemptsAt).toEqual([0, 30, 90, 210, 450, 930]);
    // ... even though the change was detected on every poll inside the overlap window (0..120 s).
    expect(detected).toBe(WALLET_REFRESH_CHANGE_OVERLAP_MS / WALLET_REFRESH_CHANGE_POLL_MS + 1);
    const jobs = await jobsOf(m.userId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: WalletPassRefreshStatus.FAILED, attempts: WALLET_REFRESH_MAX_ATTEMPTS, triggerCount: 9 });
    expect(apns.received).toHaveLength(WALLET_REFRESH_MAX_ATTEMPTS);
  });

  it('a genuinely new change during a backoff rides along with the scheduled retry: not lost, not early', async () => {
    const m = await dynamicMemberWithDevice('newchange');
    let calls = 0;
    apns.reply = () => (++calls === 1 ? { status: 503, reason: 'ServiceUnavailable' } : { status: 200 });
    await settle(new Date());
    await changeEntitlement(m.userId, new Date(Date.now() + 9 * DAY));
    exactBackoff();

    const t0 = Date.now() + SEC;
    expect((await triggers.detectChanges(new Date(t0))).enqueued).toBe(1);
    expect(await worker.processDue(new Date(t0))).toEqual([expect.objectContaining({ result: 'RETRY' })]);
    expect(await artifactOf(m.serial)).toMatchObject({ passVersion: 2, pushedPassVersion: 1 });

    // The member renews for longer while the retry waits: a second, genuinely new change.
    const renewedEnd = new Date(Date.now() + 40 * DAY);
    await changeEntitlement(m.userId, renewedEnd);
    expect((await triggers.detectChanges(new Date(t0 + 15 * SEC))).enqueued).toBe(1);
    const [pending] = await pendingOf(m.userId);
    expect(pending).toMatchObject({ attempts: 1, triggerCount: 2 });
    expect(pending!.runAfter.getTime()).toBe(t0 + 30 * SEC); // the backoff stands
    expect(await worker.processDue(new Date(t0 + 15 * SEC))).toEqual([]);

    // The retry recomputes the member's LATEST state: the renewal is on the pass and is pushed once.
    expect(await worker.processDue(new Date(t0 + 30 * SEC))).toEqual([
      expect.objectContaining({ result: 'SUCCEEDED', outcome: `${m.serial}:updated:pushed:1` }),
    ]);
    expect(await artifactOf(m.serial)).toMatchObject({ passVersion: 3, pushedPassVersion: 3 });
    const validity = (await passOf(m.serial)).generic.secondaryFields.find((f) => f.key === 'validity')?.value ?? '';
    expect(validity).toContain(formatInstantDateEs(renewedEnd, TZ));
    expect(apns.received).toHaveLength(2);
  });

  it('coalescing still pulls a never-attempted scheduled job forward (a change does not wait for a future transition)', async () => {
    const { studioId, u1 } = await bareMembers();
    const now = new Date();
    await queue.enqueue([{ studioId, userId: u1, runAfter: new Date(now.getTime() + 4 * MIN) }], 'TIME_TRANSITION', { now });
    await queue.enqueue([{ studioId, userId: u1 }], 'CHANGE_DETECTED', { now });
    const [row] = await pendingOf(u1);
    expect(row).toMatchObject({ attempts: 0, triggerCount: 2, reason: 'TIME_TRANSITION' });
    expect(row!.runAfter.getTime()).toBe(now.getTime());
  });

  // --- a trigger that lands while an attempt is RUNNING ---------------------------------------

  it('a trigger during a running attempt cannot reset the attempt count or skip the backoff', async () => {
    const { studioId, u1 } = await bareMembers();
    exactBackoff();
    const now = new Date();
    await queue.enqueue([{ studioId, userId: u1 }], 'CHANGE_DETECTED', { now });
    const [job] = await queue.claim('w1', now, 1);
    expect(job).toMatchObject({ attempts: 1 });
    await queue.enqueue([{ studioId, userId: u1 }], 'CHANGE_DETECTED', { now }); // re-detected mid-attempt
    expect(await jobsOf(u1)).toHaveLength(2);

    expect(await queue.retryOrFail(job!, 'w1', new Error('APNS_TRANSIENT:503:ServiceUnavailable'), now)).toBe('SUPERSEDED');
    const [pending] = await pendingOf(u1);
    // Before the fix the sibling started over: attempts 0, due immediately.
    expect(pending).toMatchObject({ attempts: 1, lastError: expect.stringContaining('APNS_TRANSIENT') });
    expect(pending!.runAfter.getTime()).toBe(now.getTime() + 30 * SEC);
    expect(await queue.claim('w2', new Date(now.getTime() + 15 * SEC), 1)).toEqual([]);
    expect(await queue.claim('w2', new Date(now.getTime() + 30 * SEC), 1)).toEqual([expect.objectContaining({ attempts: 2 })]);
  });

  it('a dead letter holds back a sibling queued during the final attempt until the cooldown ends; an operator request still runs it', async () => {
    const { studioId, u1 } = await bareMembers();
    exactBackoff();
    const t0 = Date.now();
    await queue.enqueue([{ studioId, userId: u1 }], 'CHANGE_DETECTED', { now: new Date(t0) });
    let t = t0;
    for (let attempt = 1; attempt < WALLET_REFRESH_MAX_ATTEMPTS; attempt += 1) {
      const [j] = await queue.claim('w', new Date(t), 1);
      expect(await queue.retryOrFail(j!, 'w', new Error('APNS_TRANSIENT'), new Date(t))).toBe('RETRY');
      t = (await pendingOf(u1))[0]!.runAfter.getTime();
    }
    const [last] = await queue.claim('w', new Date(t), 1);
    expect(last).toMatchObject({ attempts: WALLET_REFRESH_MAX_ATTEMPTS });
    await queue.enqueue([{ studioId, userId: u1 }], 'CHANGE_DETECTED', { now: new Date(t), respectCooldown: true }); // mid-attempt
    expect(await queue.retryOrFail(last!, 'w', new Error('APNS_TRANSIENT'), new Date(t))).toBe('FAILED');

    const [held] = await pendingOf(u1);
    // Before the fix the sibling ran on the next tick with a fresh budget, bypassing the cooldown.
    expect(held!.runAfter.getTime()).toBe(t + WALLET_REFRESH_DEAD_LETTER_COOLDOWN_MS);
    expect(await queue.claim('w', new Date(t + MIN), 1)).toEqual([]);
    // Automatic triggers stay away during the cooldown ...
    expect(await queue.enqueue([{ studioId, userId: u1 }], 'CHANGE_DETECTED', { now: new Date(t + MIN), respectCooldown: true })).toBe(0);
    // ... an operator request is not subject to it and pulls the held-back job forward.
    expect(await queue.enqueue([{ studioId, userId: u1 }], 'MANUAL', { now: new Date(t + 2 * MIN) })).toBe(1);
    expect(await queue.claim('w', new Date(t + 2 * MIN), 1)).toEqual([expect.objectContaining({ attempts: 1 })]);
  });

  it('a permanent (integrity) failure also holds back the sibling for the cooldown', async () => {
    const { studioId, u1 } = await bareMembers();
    const now = new Date();
    await queue.enqueue([{ studioId, userId: u1 }], 'CHANGE_DETECTED', { now });
    const [job] = await queue.claim('w', now, 1);
    await queue.enqueue([{ studioId, userId: u1 }], 'TIME_TRANSITION', { now });
    expect(await queue.fail(job!, 'w', 'WALLET_DYNAMIC_TOKEN_UNRECOVERABLE', now)).toBe(true);
    const [held] = await pendingOf(u1);
    expect(held!.runAfter.getTime()).toBe(now.getTime() + WALLET_REFRESH_DEAD_LETTER_COOLDOWN_MS);
  });

  // --- crash recovery ---------------------------------------------------------------------------

  it('crash recovery carries the attempt count into a sibling, so a job that keeps killing its worker still dead-letters', async () => {
    const { studioId, u1 } = await bareMembers();
    let t = Date.now();
    await queue.enqueue([{ studioId, userId: u1 }], 'CHANGE_DETECTED', { now: new Date(t) });
    for (let attempt = 1; attempt <= WALLET_REFRESH_MAX_ATTEMPTS; attempt += 1) {
      const [j] = await queue.claim(`crashed-${attempt}`, new Date(t), 1);
      expect(j).toMatchObject({ attempts: attempt }); // before the fix: 1, 1, 1, ... forever
      await queue.enqueue([{ studioId, userId: u1 }], 'CHANGE_DETECTED', { now: new Date(t + SEC), respectCooldown: true });
      t += WALLET_REFRESH_LEASE_MS + SEC;
      const recovered = await queue.recoverExpiredLeases(new Date(t));
      expect(recovered).toEqual(attempt < WALLET_REFRESH_MAX_ATTEMPTS ? { requeued: 0, superseded: 1, failed: 0 } : { requeued: 0, superseded: 0, failed: 1 });
      expect((await pendingOf(u1)).length).toBe(1);
    }
    const statuses = (await jobsOf(u1)).map((j) => j.status);
    expect(statuses.filter((s) => s === WalletPassRefreshStatus.SUPERSEDED)).toHaveLength(WALLET_REFRESH_MAX_ATTEMPTS - 1);
    expect(statuses.filter((s) => s === WalletPassRefreshStatus.FAILED)).toHaveLength(1);
    const [held] = await pendingOf(u1);
    expect(held!.runAfter.getTime()).toBe(t + WALLET_REFRESH_DEAD_LETTER_COOLDOWN_MS);
  });

  it('crash recovery without a sibling still re-queues at once (an expired lease is not a failure of the job)', async () => {
    const { studioId, u1 } = await bareMembers();
    const now = new Date();
    await queue.enqueue([{ studioId, userId: u1 }], 'MANUAL', { now });
    await queue.claim('crashed', now, 1);
    const later = new Date(now.getTime() + WALLET_REFRESH_LEASE_MS + SEC);
    expect(await queue.recoverExpiredLeases(later)).toEqual({ requeued: 1, superseded: 0, failed: 0 });
    const [row] = await pendingOf(u1);
    expect(row).toMatchObject({ attempts: 1, lastError: 'LEASE_EXPIRED' });
    expect(row!.runAfter.getTime()).toBe(later.getTime());
  });
});
