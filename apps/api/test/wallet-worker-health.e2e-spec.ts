// Must stay the first import: sets the Smart Wallet env (worker flag ON) before AppModule is imported.
import './helpers/wallet-dynamic-env.worker-on';
import * as http2 from 'node:http2';
import http2Module from 'node:http2';
import type { INestApplication } from '@nestjs/common';
import { Role, SubscriptionSource, SubscriptionStatus, WalletPassRefreshStatus } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { extractPassJsonFromPkpass } from '../src/wallet/apple/pkpass-reader';
import { WalletDynamicPassService } from '../src/wallet/dynamic/wallet-dynamic-pass.service';
import { WALLET_WORKER_HEARTBEAT_CURSOR, WALLET_WORKER_RUNNING_SINCE_CURSOR } from '../src/wallet/refresh/wallet-refresh.constants';
import { WalletHealthService, walletHealthNeedsAttention, type WalletHealthReport } from '../src/wallet/refresh/wallet-health.service';
import { WalletRefreshTriggersService } from '../src/wallet/refresh/wallet-refresh-triggers.service';
import { WalletRefreshWorkerService } from '../src/wallet/refresh/wallet-refresh-worker.service';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import { createMembership, createStudio, createUserWithPassword } from './helpers/factories';
import { appleFixture } from './helpers/wallet-dynamic-env';

/**
 * Smart Wallet 2.0 Stage 4A.1 — refresh worker liveness in the health report.
 *
 * Regression for the Stage 4A staging finding: the first health evaluation after the worker had
 * been off for more than 2 h reported HIGH WORKER_IDLE, because the first reconciliation is
 * deliberately delayed 5–15 min. The worker flag is ON here so health evaluates liveness, but the
 * background timer is never started: each test drives worker.tick() with an explicit clock.
 */
const TZ = 'America/Mexico_City';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

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

maybeDescribe('Smart Wallet 2.0 Stage 4A.1 — refresh worker liveness (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let dynamic: WalletDynamicPassService;
  let triggers: WalletRefreshTriggersService;
  let worker: WalletRefreshWorkerService;
  let health: WalletHealthService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    dynamic = app.get(WalletDynamicPassService);
    triggers = app.get(WalletRefreshTriggersService);
    worker = app.get(WalletRefreshWorkerService);
    health = app.get(WalletHealthService);
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    newWorkerProcess();
  });

  afterAll(async () => {
    await app.close();
  });

  // --- helpers ---------------------------------------------------------------------------------

  /** A restart is a new process: the worker has not written a heartbeat yet. */
  function newWorkerProcess(): void {
    (worker as unknown as { heartbeatWrittenAt: number | null }).heartbeatWrittenAt = null;
  }

  const at = (base: Date, ms: number) => new Date(base.getTime() + ms);
  const workerCodes = (r: WalletHealthReport) => r.findings.filter((f) => f.code === 'WORKER_IDLE' || f.code === 'WORKER_STOPPED').map((f) => f.code);

  async function cursor(source: string): Promise<Date | null> {
    return (await prisma.walletRefreshCursor.findUnique({ where: { source } }))?.position ?? null;
  }

  /** One member with a DYNAMIC pass, so reconciliation has work and liveness is evaluated. */
  async function dynamicMember() {
    const studio = await createStudio(prisma, { timezone: TZ });
    const member = await createUserWithPassword(prisma, { email: `liveness-${Math.random().toString(36).slice(2, 8)}@e2e.local` });
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    const plan = await prisma.membershipPlan.create({
      data: { studioId: studio.id, name: 'Full Access', priceCents: 120000, currency: 'mxn', billingInterval: 'MONTHLY', active: true, allClassesAccess: true, openGymAccess: true, exclusiveGroup: 'CORE' },
    });
    await prisma.subscription.create({
      data: {
        studioId: studio.id, userId: member.id, membershipPlanId: plan.id, status: SubscriptionStatus.ACTIVE, source: SubscriptionSource.CASH,
        currentPeriodStart: new Date(Date.now() - DAY), currentPeriodEnd: new Date(Date.now() + 29 * DAY), cancelAtPeriodEnd: true, exclusiveGroupKey: 'CORE',
      },
    });
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: member.email, password: member.password }).expect(201);
    const jwt = (login.body as { accessToken: string }).accessToken;
    const res = await request(app.getHttpServer()).post(`/api/v1/studios/${studio.id}/wallet/apple`).set('Authorization', `Bearer ${jwt}`).buffer(true).parse(binaryParser).expect(200);
    await dynamic.enroll((await extractPassJsonFromPkpass(res.body as Buffer)).serialNumber as string);
    return { studioId: studio.id, userId: member.id };
  }

  /** The first reconciliation, as the worker runs it 5–15 min after a start. */
  async function firstReconciliation(now: Date) {
    expect((await triggers.reconcileAll(now)).enqueued).toBeGreaterThan(0);
    expect(await worker.processDue(now, 50)).toEqual([expect.objectContaining({ result: 'SUCCEEDED' })]);
  }

  // --- tests -----------------------------------------------------------------------------------

  it('fresh start after a long disabled period: no WORKER_IDLE while the first reconciliation is pending (Stage 4A staging finding)', async () => {
    const m = await dynamicMember();
    const t0 = new Date();
    // The previous run ended ~6 h ago (staging: last completed job 356 min before the restart).
    const sixHoursAgo = at(t0, -6 * HOUR);
    await prisma.walletPassRefreshJob.create({
      data: { studioId: m.studioId, userId: m.userId, status: WalletPassRefreshStatus.SUCCEEDED, reason: 'RECONCILIATION', attempts: 1, runAfter: sixHoursAgo, startedAt: sixHoursAgo, completedAt: sixHoursAgo, outcome: 'earlier run' },
    });
    await prisma.walletRefreshCursor.createMany({
      data: [
        { source: WALLET_WORKER_RUNNING_SINCE_CURSOR, position: at(t0, -30 * HOUR) },
        { source: WALLET_WORKER_HEARTBEAT_CURSOR, position: sixHoursAgo },
      ],
    });

    // The first loop iteration of the new process (it also runs the in-process health phase).
    expect(await worker.tick(t0)).not.toBeNull();
    const atStart = await health.evaluate(t0);
    expect(workerCodes(atStart)).toEqual([]); // before 4A.1: ['WORKER_IDLE'] (HIGH, idleMinutes 360)
    expect(atStart.worker).toMatchObject({ state: 'STARTING', reason: null, runningSince: t0.toISOString(), lastHeartbeatAt: t0.toISOString() });
    // Nothing else needs attention either (the throwaway test certificate is valid for ~1 day,
    // so CERTIFICATE_EXPIRY is expected in this suite and excluded).
    expect(atStart.findings.filter((f) => f.code !== 'CERTIFICATE_EXPIRY' && (f.severity === 'HIGH' || f.severity === 'CRITICAL'))).toEqual([]);

    // Alive and waiting for the delayed first reconciliation.
    await health.recordWorkerHeartbeat(at(t0, 10 * MIN), { starting: false });
    const waiting = await health.evaluate(at(t0, 10 * MIN));
    expect(waiting.worker).toMatchObject({ state: 'AWAITING_FIRST_RUN', firstRunDeadline: at(t0, 25 * MIN).toISOString() });
    expect(workerCodes(waiting)).toEqual([]);

    // The first reconciliation completes: healthy.
    await firstReconciliation(at(t0, 12 * MIN));
    await health.recordWorkerHeartbeat(at(t0, 12 * MIN), { starting: false });
    const healthy = await health.evaluate(at(t0, 12 * MIN));
    expect(healthy.worker).toMatchObject({ state: 'HEALTHY', lastCompletedAt: at(t0, 12 * MIN).toISOString() });
    expect(workerCodes(healthy)).toEqual([]);
  });

  it('a worker whose loop stops is STOPPED (HIGH) even inside the startup grace', async () => {
    await dynamicMember();
    const t0 = new Date();
    await worker.tick(t0);
    const later = await health.evaluate(at(t0, 6 * MIN)); // no heartbeat for 6 min
    expect(later.worker).toMatchObject({ state: 'STOPPED', reason: 'HEARTBEAT_STALE' });
    expect(later.findings).toContainEqual(expect.objectContaining({ code: 'WORKER_STOPPED', severity: 'HIGH', metrics: { reason: 'HEARTBEAT_STALE', minutesSinceHeartbeat: 6 } }));
    expect(walletHealthNeedsAttention({ maxSeverity: later.findings.find((f) => f.code === 'WORKER_STOPPED')!.severity })).toBe(true); // cron exit 3
  });

  it('enabled but never started: STOPPED / NEVER_STARTED (HIGH)', async () => {
    await dynamicMember();
    const r = await health.evaluate(new Date());
    expect(r.worker).toMatchObject({ state: 'STOPPED', reason: 'NEVER_STARTED', lastHeartbeatAt: null });
    expect(workerCodes(r)).toEqual(['WORKER_STOPPED']);
  });

  it('a first reconciliation that never completes is WORKER_IDLE once the bounded grace ends', async () => {
    await dynamicMember();
    const t0 = new Date();
    await worker.tick(t0);
    // The loop keeps ticking, but nothing ever completes.
    await health.recordWorkerHeartbeat(at(t0, 24 * MIN), { starting: false });
    expect((await health.evaluate(at(t0, 24 * MIN))).worker.state).toBe('AWAITING_FIRST_RUN');
    await health.recordWorkerHeartbeat(at(t0, 26 * MIN), { starting: false });
    const overdue = await health.evaluate(at(t0, 26 * MIN));
    expect(overdue.worker).toMatchObject({ state: 'IDLE', reason: 'FIRST_RUN_OVERDUE' });
    expect(overdue.findings).toContainEqual(
      expect.objectContaining({ code: 'WORKER_IDLE', severity: 'HIGH', metrics: { reason: 'FIRST_RUN_OVERDUE', minutesSinceStart: 26, idleMinutes: null } }),
    );
  });

  it('a running worker that stops completing jobs for over 2 h is WORKER_IDLE', async () => {
    await dynamicMember();
    const t0 = new Date();
    await worker.tick(t0);
    await firstReconciliation(at(t0, 10 * MIN));
    const stalled = at(t0, 10 * MIN + 2 * HOUR + MIN);
    await health.recordWorkerHeartbeat(stalled, { starting: false });
    const r = await health.evaluate(stalled);
    expect(r.worker).toMatchObject({ state: 'IDLE', reason: 'NO_RECENT_COMPLETED_JOB' });
    expect(workerCodes(r)).toEqual(['WORKER_IDLE']);
  });

  it('a quick restart (a deploy) continues the run; a start after a long gap begins a new one', async () => {
    const t0 = new Date();
    await health.recordWorkerHeartbeat(t0, { starting: true });
    await health.recordWorkerHeartbeat(at(t0, 1 * MIN), { starting: false });
    await health.recordWorkerHeartbeat(at(t0, 2 * MIN), { starting: true }); // new process 1 min after the last heartbeat
    expect(await cursor(WALLET_WORKER_RUNNING_SINCE_CURSOR)).toEqual(t0);
    await health.recordWorkerHeartbeat(at(t0, 20 * MIN), { starting: true }); // re-enabled after an 18 min gap
    expect(await cursor(WALLET_WORKER_RUNNING_SINCE_CURSOR)).toEqual(at(t0, 20 * MIN));
    expect(await cursor(WALLET_WORKER_HEARTBEAT_CURSOR)).toEqual(at(t0, 20 * MIN));
  });

  it('only the loop writes liveness: an operator cycle (runOnce) never does; the loop throttles writes to every 30 s', async () => {
    await dynamicMember();
    const t0 = new Date();
    await worker.runOnce(t0, { force: true });
    expect(await cursor(WALLET_WORKER_HEARTBEAT_CURSOR)).toBeNull();
    expect(await cursor(WALLET_WORKER_RUNNING_SINCE_CURSOR)).toBeNull();

    await worker.tick(at(t0, 5_000));
    expect(await cursor(WALLET_WORKER_HEARTBEAT_CURSOR)).toEqual(at(t0, 5_000));
    await worker.tick(at(t0, 15_000));
    expect(await cursor(WALLET_WORKER_HEARTBEAT_CURSOR)).toEqual(at(t0, 5_000));
    await worker.tick(at(t0, 40_000));
    expect(await cursor(WALLET_WORKER_HEARTBEAT_CURSOR)).toEqual(at(t0, 40_000));
    expect(await cursor(WALLET_WORKER_RUNNING_SINCE_CURSOR)).toEqual(at(t0, 5_000));
  });
});
