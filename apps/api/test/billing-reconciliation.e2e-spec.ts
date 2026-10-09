import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentMethod, PaymentStatus, SubscriptionEndReason, SubscriptionSource, SubscriptionStatus } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { StripeService } from '../src/stripe/stripe.service';
import { BillingAlertService } from '../src/billing/reconciliation/billing-alert.service';
import { BillingReconciliationRunService } from '../src/billing/reconciliation/billing-reconciliation-run.service';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import { buildWorld, login, signedPost, stripeMutationCalls, stripeSubscriptionLike, type ReliabilityWorld } from './helpers/billing-reliability';

/**
 * Automatic detection, the durable case model, operator actions, alerting and tenant isolation —
 * on real Postgres with Stripe list calls mocked (GET-only in production).
 */
describe('Billing reliability — reconciliation cases, runs, alerts (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let stripe: Record<string, jest.Mock>;
  let runs: BillingReconciliationRunService;
  let alerts: BillingAlertService;
  const ENV_KEYS = ['BILLING_ALERTS_ENABLED', 'BILLING_ALERT_WEBHOOK_URL', 'BILLING_ALERT_EMAIL_TO', 'BILLING_ALERT_MIN_SEVERITY', 'BILLING_ALERT_ESCALATION_HOURS', 'BILLING_ALERT_ADMIN_BASE_URL'];

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    stripe = app.get(StripeService) as unknown as Record<string, jest.Mock>;
    runs = app.get(BillingReconciliationRunService);
    alerts = app.get(BillingAlertService);
    app.get(ConfigService);
  });

  afterAll(async () => {
    await truncateAll(prisma);
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    jest.clearAllMocks();
    jest.restoreAllMocks();
    for (const k of ENV_KEYS) delete process.env[k];
    stripe['listSubscriptionsForCustomer'].mockResolvedValue([]);
    stripe['listOpenInvoicesForCustomer'].mockResolvedValue([]);
    stripe['listRefundsSince'].mockResolvedValue({ data: [], hasMore: false });
    stripe['listDisputesSince'].mockResolvedValue({ data: [], hasMore: false });
    stripe['findPaidInvoicePaymentIntentId'].mockResolvedValue(null);
    stripe['findInvoiceIdForPaymentIntent'].mockResolvedValue(null);
    stripe['retrieveSubscription'].mockImplementation(async (id: string) => ({ id, object: 'subscription', status: 'active', cancellation_details: null, metadata: {}, items: { data: [] } }));
  });

  const api = () => request(app.getHttpServer());
  const base = (w: ReliabilityWorld) => `/api/v1/studios/${w.studio.id}/billing/reconciliation`;
  const cases = (studioId: string) => prisma.billingReconciliationCase.findMany({ where: { studioId }, orderBy: { createdAt: 'asc' } });
  const stripeLists = (w: ReliabilityWorld, subs: ReturnType<typeof stripeSubscriptionLike>[]) =>
    stripe['listSubscriptionsForCustomer'].mockImplementation(async (customerId: string) => (customerId === 'cus_fx_member' ? subs : []));
  const canceledInStripe = (w: ReliabilityWorld) => stripeSubscriptionLike({ id: 'sub_fx_full', customer: 'cus_fx_member', status: 'canceled', studioId: w.studio.id, userId: w.member.id, planId: w.full.id, canceledAt: 1790561641, cancellationReason: 'payment_failed', latestInvoice: 'in_fx0032' });
  const activeInStripe = (w: ReliabilityWorld, extra: Partial<Parameters<typeof stripeSubscriptionLike>[0]> = {}) => stripeSubscriptionLike({ id: 'sub_fx_full', customer: 'cus_fx_member', status: 'active', studioId: w.studio.id, userId: w.member.id, planId: w.full.id, ...extra });

  /** Money/access tables, byte-for-byte: detection and auto-resolution must never touch them. */
  const financialSnapshot = async () => JSON.stringify({
    subscriptions: await prisma.subscription.findMany({ orderBy: { id: 'asc' } }),
    payments: await prisma.payment.findMany({ orderBy: { id: 'asc' } }),
    cycles: await prisma.membershipEntitlementCycle.findMany({ orderBy: { id: 'asc' } }),
  });

  it('D1: detects "Stripe canceled, GymOS alive" (the Incident B state) as HIGH, once, with evidence; repeated runs update instead of duplicating', async () => {
    const w = await buildWorld(prisma, { fullStatus: SubscriptionStatus.PAST_DUE });
    stripeLists(w, [canceledInStripe(w)]);
    const beforeRuns = await financialSnapshot();
    const first = await runs.runStudio(w.studio.id, 'MANUAL', { dispatchAlerts: false });
    expect(await financialSnapshot()).toBe(beforeRuns); // detection writes cases, never money or access
    expect(first.status).toBe('COMPLETED');
    expect(first.studios[0]).toMatchObject({ created: 1, checkedMembers: 1, error: null, incompleteCategories: [] });
    const [c] = await cases(w.studio.id);
    expect(c).toMatchObject({ category: 'STRIPE_CANCELED_LOCAL_ALIVE', severity: 'HIGH', status: 'OPEN', reasonCode: 'STRIPE_CANCELED', subscriptionId: w.sub.id, userId: w.member.id, stripeSubscriptionId: 'sub_fx_full' });
    expect(c!.evidence).toMatchObject({ localStatus: 'PAST_DUE', stripeStatus: 'canceled', stripeCancellationReason: 'payment_failed' });
    expect(c!.suggestedAction).toMatch(/No registres cobros manuales/);

    const second = await runs.runStudio(w.studio.id, 'MANUAL', { dispatchAlerts: false });
    expect(second.studios[0]).toMatchObject({ created: 0, updated: 1, reopened: 0 });
    expect(await cases(w.studio.id)).toHaveLength(1);
    expect((await cases(w.studio.id))[0]).toMatchObject({ observationCount: 2, occurrenceCount: 1, firstDetectedAt: c!.firstDetectedAt });
    // Stripe untouched by detection.
    expect(stripeMutationCalls(stripe)).toBe(0);
  });

  it('D2: a corrected discrepancy auto-resolves on the next complete run; recurring later reopens the SAME case with occurrenceCount 2', async () => {
    const w = await buildWorld(prisma, { fullStatus: SubscriptionStatus.PAST_DUE });
    stripeLists(w, [canceledInStripe(w)]);
    await runs.runStudio(w.studio.id, 'MANUAL', { dispatchAlerts: false });
    // Operator corrects the row (like the approved 2026-10-08 reconciliation).
    await prisma.subscription.update({ where: { id: w.sub.id }, data: { status: SubscriptionStatus.CANCELED, endReason: SubscriptionEndReason.PAYMENT_FAILED } });
    const beforeFixRun = await financialSnapshot();
    const fixRun = await runs.runStudio(w.studio.id, 'MANUAL', { dispatchAlerts: false });
    expect(fixRun.studios[0]!.autoResolved).toBe(1);
    expect(await financialSnapshot()).toBe(beforeFixRun); // auto-resolution is case bookkeeping only
    const resolved = (await cases(w.studio.id))[0]!;
    expect(resolved).toMatchObject({ status: 'RESOLVED', resolvedByUserId: null, resolutionNote: expect.stringContaining('revisión automática') });
    expect((resolved.history as Array<{ type: string }>).map((h) => h.type)).toEqual(['DETECTED', 'AUTO_RESOLVED']);

    // Recurrence: someone flips it back.
    await prisma.subscription.update({ where: { id: w.sub.id }, data: { status: SubscriptionStatus.ACTIVE } });
    const again = await runs.runStudio(w.studio.id, 'MANUAL', { dispatchAlerts: false });
    expect(again.studios[0]).toMatchObject({ reopened: 1, created: 0 });
    const reopened = (await cases(w.studio.id))[0]!;
    expect(reopened).toMatchObject({ id: resolved.id, status: 'OPEN', occurrenceCount: 2, resolvedAt: null, lastAlertedAt: null });
    expect((reopened.history as Array<{ type: string }>).map((h) => h.type)).toEqual(['DETECTED', 'AUTO_RESOLVED', 'REOPENED']);
  });

  it('D2b: cases opened by webhooks survive a complete nightly run — a CRITICAL late payment is re-observed, a MEDIUM fixed window is event-only', async () => {
    const w = await buildWorld(prisma);
    const webhookSecret = app.get(ConfigService).getOrThrow<string>('STRIPE_WEBHOOK_SECRET');
    const post = (e: Parameters<typeof signedPost>[2]) => signedPost(app, webhookSecret, e);
    // Monthly: Stripe cancels, then the open invoice is paid later → CRITICAL (webhook).
    await post(w.subscriptionEvent({ type: 'customer.subscription.deleted' })).expect(200);
    stripe['retrieveSubscription'].mockImplementation(async (id: string) => ({ id, object: 'subscription', status: 'canceled', cancellation_details: { reason: 'payment_failed' }, metadata: {}, items: { data: [] } }));
    await post(w.monthlyPaidInvoice({ invoiceId: 'in_fx0032', paidAt: w.nowUnix() })).expect(200);
    // Fixed-duration: a canceled Booty row paid late → MEDIUM window granted (webhook).
    const bootySub = await prisma.subscription.create({ data: { studioId: w.studio.id, userId: w.member.id, membershipPlanId: w.booty.id, status: SubscriptionStatus.CANCELED, endReason: SubscriptionEndReason.PAYMENT_FAILED, source: SubscriptionSource.STRIPE, stripeSubscriptionId: 'sub_fx_booty_member', exclusiveGroupKey: null, currentPeriodStart: new Date('2026-08-18T16:54:40Z'), currentPeriodEnd: new Date('2026-10-02T16:54:40Z'), entitlementEndsAt: new Date('2026-10-02T16:54:40Z') } });
    await post(w.bootyPaidInvoice({ paidAt: w.nowUnix() })).expect(200);
    const before = await cases(w.studio.id);
    expect(before.map((c) => [c.reasonCode, c.status])).toEqual([['SUBSCRIPTION_ENDED', 'OPEN'], ['LATE_FIXED_WINDOW_GRANTED', 'OPEN']]);

    // Nightly: Stripe fully consulted (both subscriptions canceled) → every category "complete".
    stripeLists(w, [
      canceledInStripe(w),
      stripeSubscriptionLike({ id: 'sub_fx_booty_member', customer: 'cus_fx_member', status: 'canceled', studioId: w.studio.id, userId: w.member.id, planId: w.booty.id, priceId: 'price_fx_booty_45d', canceledAt: 1790561641, cancellationReason: 'payment_failed' }),
    ]);
    const run = await runs.runStudio(w.studio.id, 'MANUAL', { dispatchAlerts: false });
    expect(run.status).toBe('COMPLETED');
    expect(run.studios[0]!.autoResolved).toBe(0);
    const after = await cases(w.studio.id);
    expect(after.map((c) => [c.reasonCode, c.status])).toEqual(expect.arrayContaining([['SUBSCRIPTION_ENDED', 'OPEN'], ['LATE_FIXED_WINDOW_GRANTED', 'OPEN']]));
    expect(after.find((c) => c.reasonCode === 'SUBSCRIPTION_ENDED')).toMatchObject({ observationCount: 2, severity: 'CRITICAL' });
    expect(bootySub.id).toBeTruthy();
  });

  it('D3: no auto-resolution when Stripe could not be fully consulted (PARTIAL run)', async () => {
    const w = await buildWorld(prisma, { fullStatus: SubscriptionStatus.PAST_DUE });
    stripeLists(w, [canceledInStripe(w)]);
    await runs.runStudio(w.studio.id, 'MANUAL', { dispatchAlerts: false });
    stripe['listSubscriptionsForCustomer'].mockRejectedValue(Object.assign(new Error('Stripe is down'), { type: 'StripeAPIError', statusCode: 503 }));
    const partial = await runs.runStudio(w.studio.id, 'MANUAL', { dispatchAlerts: false });
    expect(partial.status).toBe('PARTIAL');
    expect(partial.studios[0]!.incompleteCategories).toContain('STRIPE_CANCELED_LOCAL_ALIVE');
    expect(partial.studios[0]!.autoResolved).toBe(0);
    expect((await cases(w.studio.id))[0]!.status).toBe('OPEN');
    expect(await prisma.billingReconciliationRun.findFirst({ orderBy: { startedAt: 'desc' } })).toMatchObject({ status: 'PARTIAL' });
  });

  it('D4: the other detectors — local-canceled/Stripe-alive, orphan, duplicate, open invoice, stale period, reason mismatch, dunning, dead letter, paid-without-cycle', async () => {
    const w = await buildWorld(prisma, { fullStatus: SubscriptionStatus.CANCELED });
    await prisma.subscription.update({ where: { id: w.sub.id }, data: { endReason: SubscriptionEndReason.MEMBER_CANCELLED } });
    const bootySub = await prisma.subscription.create({ data: { studioId: w.studio.id, userId: w.member.id, membershipPlanId: w.booty.id, status: SubscriptionStatus.ACTIVE, source: SubscriptionSource.STRIPE, stripeSubscriptionId: 'sub_fx_booty_member', exclusiveGroupKey: null, currentPeriodStart: new Date('2026-08-18T16:54:40Z'), currentPeriodEnd: new Date('2026-10-02T16:54:40Z'), entitlementEndsAt: new Date('2026-10-02T16:54:40Z') } });
    await prisma.payment.create({ data: { studioId: w.studio.id, userId: w.member.id, subscriptionId: bootySub.id, membershipPlanId: w.booty.id, amountCents: 80000, currency: 'mxn', status: PaymentStatus.SUCCEEDED, paymentMethod: PaymentMethod.STRIPE, stripeInvoiceId: 'in_fx_booty_renewal', paidAt: new Date('2026-10-02T16:54:43Z') } });
    // Stored deletion event says payment_failed while the row says MEMBER_CANCELLED.
    await prisma.stripeWebhookEvent.create({ data: { stripeEventId: 'evt_stored_del', eventType: 'customer.subscription.deleted', processed: true, payload: { id: 'evt_stored_del', type: 'customer.subscription.deleted', data: { object: { id: 'sub_fx_full', object: 'subscription', status: 'canceled', cancellation_details: { reason: 'payment_failed' }, metadata: w.fullMetadata } } } } });
    // Dead-lettered invoice.paid for this studio + a dunning sequence on a PAST_DUE sibling member.
    await prisma.stripeWebhookEvent.create({ data: { stripeEventId: 'evt_dead', eventType: 'invoice.paid', processed: false, attemptCount: 5, lastError: '[fixed-duration-entitlement:NO_SERVICE_LINE] boom', createdAt: new Date(Date.now() - 2 * 3_600_000), payload: { data: { object: { id: 'in_dead', object: 'invoice', parent: { subscription_details: { metadata: w.fullMetadata } } } } } } });
    const stripeSubs = [
      activeInStripe(w), // local CANCELED but Stripe active → LOCAL_CANCELED_STRIPE_ALIVE
      stripeSubscriptionLike({ id: 'sub_fx_orphan', customer: 'cus_fx_member', status: 'active', studioId: w.studio.id, userId: w.member.id, planId: w.full.id }), // orphan + duplicate family with sub_fx_full
    ];
    stripeLists(w, stripeSubs);
    stripe['listOpenInvoicesForCustomer'].mockResolvedValue([{ id: 'in_open', object: 'invoice', amount_remaining: 150000, currency: 'mxn', created: Math.floor(Date.now() / 1000) - 20 * 86400, attempt_count: 9, next_payment_attempt: null, auto_advance: false, parent: { subscription_details: { subscription: 'sub_fx_full' } } }]);

    const run = await runs.runStudio(w.studio.id, 'MANUAL', { dispatchAlerts: false });
    expect(run.status).toBe('COMPLETED');
    const found = (await cases(w.studio.id)).map((c) => `${c.category}:${c.reasonCode}`).sort();
    expect(found).toEqual(expect.arrayContaining([
      'LOCAL_CANCELED_STRIPE_ALIVE:LOCAL_CANCELED',
      'SUBSCRIPTION_IDENTITY_MISMATCH:STRIPE_ORPHAN',
      'SUBSCRIPTION_IDENTITY_MISMATCH:DUPLICATE_RENEWABLE',
      'OPEN_INVOICE_ON_ENDED_SUBSCRIPTION:OPEN_INVOICE_AFTER_CANCEL',
      'CANCELLATION_REASON_MISMATCH:EXPECTED_PAYMENT_FAILED',
      'PAID_WITHOUT_ENTITLEMENT:FIXED_DURATION_NO_CYCLE',
      'WEBHOOK_DEAD_LETTER:PAID_EVENT_UNPROCESSED',
    ]));
    const deadLetter = (await cases(w.studio.id)).find((c) => c.category === 'WEBHOOK_DEAD_LETTER')!;
    expect(deadLetter).toMatchObject({ severity: 'CRITICAL', stripeEventId: 'evt_dead' });
    expect((await cases(w.studio.id)).find((c) => c.category === 'OPEN_INVOICE_ON_ENDED_SUBSCRIPTION')!.summary).toMatch(/NO restaurará el acceso automáticamente/);
  });

  it('D5: no false positives for cash memberships, scheduled cancellations, trials, Stripe→cash handoffs, excluded accounts or expired history', async () => {
    const w = await buildWorld(prisma);
    await prisma.subscription.create({ data: { studioId: w.studio.id, userId: w.member.id, membershipPlanId: w.booty.id, status: SubscriptionStatus.ACTIVE, source: SubscriptionSource.CASH, exclusiveGroupKey: null, currentPeriodStart: new Date(Date.now() - 86400e3), currentPeriodEnd: new Date(Date.now() + 86400e3), cancelAtPeriodEnd: true } });
    await prisma.subscription.create({ data: { studioId: w.studio.id, userId: w.member.id, membershipPlanId: w.booty.id, status: SubscriptionStatus.CANCELED, source: SubscriptionSource.CASH, exclusiveGroupKey: null, currentPeriodStart: new Date('2026-01-01'), currentPeriodEnd: new Date('2026-02-01'), endReason: SubscriptionEndReason.SUPERSEDED_RENEWAL } });
    const review = await prisma.user.create({ data: { email: 'review@e2e.local', firstName: 'App', lastName: 'Review', stripeCustomerId: 'cus_review_fake' } });
    await prisma.studioMembership.create({ data: { userId: review.id, studioId: w.studio.id, role: 'MEMBER', excludeFromAnalytics: true } });
    await prisma.subscription.create({ data: { studioId: w.studio.id, userId: review.id, membershipPlanId: w.full.id, status: SubscriptionStatus.ACTIVE, source: SubscriptionSource.STRIPE, stripeSubscriptionId: 'sub_review_fake', exclusiveGroupKey: 'CORE' } });
    stripeLists(w, [activeInStripe(w, { cancelAtPeriodEnd: true })]);
    const run = await runs.runStudio(w.studio.id, 'MANUAL', { dispatchAlerts: false });
    expect(run.studios[0]).toMatchObject({ issues: 0, checkedMembers: 1 });
    expect(await cases(w.studio.id)).toHaveLength(0);
    expect(stripe['listSubscriptionsForCustomer']).not.toHaveBeenCalledWith('cus_review_fake', expect.anything());
  });

  it('D6: tenant isolation — cases are scoped by studio in detection, listing, detail and actions', async () => {
    const a = await buildWorld(prisma, { fullStatus: SubscriptionStatus.PAST_DUE });
    const b = await buildWorld(prisma, { fullStatus: SubscriptionStatus.PAST_DUE, suffix: '_b' });
    stripe['listSubscriptionsForCustomer'].mockImplementation(async (customerId: string) =>
      customerId === 'cus_fx_member' ? [canceledInStripe(a)] : customerId === 'cus_fx_member_b' ? [stripeSubscriptionLike({ id: 'sub_fx_full_b', customer: 'cus_fx_member_b', status: 'canceled', studioId: b.studio.id, userId: b.member.id, planId: b.full.id, canceledAt: 1790561641, cancellationReason: 'payment_failed' })] : []);
    await runs.runAllStudios('CRON', { dispatchAlerts: false });
    expect((await cases(a.studio.id)).map((c) => c.subscriptionId)).toEqual([a.sub.id]);
    expect((await cases(b.studio.id)).map((c) => c.subscriptionId)).toEqual([b.sub.id]);

    const ownerA = await login(app, a.owner.email, a.owner.password);
    const listA = await api().get(`${base(a)}/cases`).set('Authorization', `Bearer ${ownerA}`).expect(200);
    expect(listA.body.items).toHaveLength(1);
    expect(listA.body.items[0]).toMatchObject({ subscriptionId: a.sub.id, member: { id: a.member.id, reference: 'Fixture M.' }, categoryLabel: 'Stripe canceló; GymOS la mantiene vigente', severityLabel: 'Alto', statusLabel: 'Abierto' });
    expect(JSON.stringify(listA.body)).not.toContain('@'); // no emails anywhere
    const caseB = (await cases(b.studio.id))[0]!;
    await api().get(`${base(a)}/cases/${caseB.id}`).set('Authorization', `Bearer ${ownerA}`).expect(404);
    await api().post(`${base(a)}/cases/${caseB.id}/acknowledge`).set('Authorization', `Bearer ${ownerA}`).send({}).expect(404);
    await api().get(`${base(b)}/cases`).set('Authorization', `Bearer ${ownerA}`).expect(403); // not a member of studio B
  });

  it('D7: operator actions and permissions — STAFF reads, OWNER/ADMIN act, FRONT_DESK and members get nothing; status transitions are enforced', async () => {
    const w = await buildWorld(prisma, { fullStatus: SubscriptionStatus.PAST_DUE });
    stripeLists(w, [canceledInStripe(w)]);
    await runs.runStudio(w.studio.id, 'MANUAL', { dispatchAlerts: false });
    const c = (await cases(w.studio.id))[0]!;
    const [owner, admin, staff, frontDesk, member] = await Promise.all([
      login(app, w.owner.email, w.owner.password), login(app, w.admin.email, w.admin.password), login(app, w.staff.email, w.staff.password),
      login(app, w.frontDesk.email, w.frontDesk.password), login(app, w.member.email, w.member.password),
    ]);
    await api().get(`${base(w)}/cases`).set('Authorization', `Bearer ${staff}`).expect(200);
    await api().get(`${base(w)}/cases`).set('Authorization', `Bearer ${frontDesk}`).expect(403);
    await api().get(`${base(w)}/cases`).set('Authorization', `Bearer ${member}`).expect(403);
    await api().get(`${base(w)}/cases`).expect(401);
    await api().post(`${base(w)}/cases/${c.id}/acknowledge`).set('Authorization', `Bearer ${staff}`).send({}).expect(403);

    const ack = await api().post(`${base(w)}/cases/${c.id}/acknowledge`).set('Authorization', `Bearer ${admin}`).send({ note: 'Revisando con Stripe' }).expect(200);
    expect(ack.body).toMatchObject({ status: 'ACKNOWLEDGED', statusSentence: 'Este caso ya fue revisado y sigue en seguimiento.' });
    await api().post(`${base(w)}/cases/${c.id}/acknowledge`).set('Authorization', `Bearer ${admin}`).send({}).expect(403); // already acknowledged
    const resolved = await api().post(`${base(w)}/cases/${c.id}/resolve`).set('Authorization', `Bearer ${owner}`).send({ note: 'Fila corregida a CANCELED' }).expect(200);
    expect(resolved.body).toMatchObject({ status: 'RESOLVED', resolutionNote: 'Fila corregida a CANCELED', statusSentence: 'Se corrigió la discrepancia.' });
    expect((resolved.body.history as Array<{ type: string; byUserId?: string }>).map((h) => h.type)).toEqual(['DETECTED', 'ACKNOWLEDGED', 'RESOLVED']);
    await api().post(`${base(w)}/cases/${c.id}/dismiss`).set('Authorization', `Bearer ${owner}`).send({ note: 'x' }).expect(403); // not active
    const reopened = await api().post(`${base(w)}/cases/${c.id}/reopen`).set('Authorization', `Bearer ${owner}`).send({}).expect(200);
    expect(reopened.body).toMatchObject({ status: 'OPEN', occurrenceCount: 2 });
    const dismissed = await api().post(`${base(w)}/cases/${c.id}/dismiss`).set('Authorization', `Bearer ${owner}`).send({ note: 'Cuenta de prueba' }).expect(200);
    expect(dismissed.body).toMatchObject({ status: 'DISMISSED', dismissReason: 'Cuenta de prueba' });
    // A dismissed case stays quiet when observed again.
    await runs.runStudio(w.studio.id, 'MANUAL', { dispatchAlerts: false });
    expect((await cases(w.studio.id))[0]).toMatchObject({ status: 'DISMISSED', observationCount: 2 });
    // Manual run endpoint + latest run.
    const manual = await api().post(`${base(w)}/runs`).set('Authorization', `Bearer ${admin}`).send({}).expect(200);
    expect(manual.body).toMatchObject({ status: 'COMPLETED', trigger: 'MANUAL' });
    await api().post(`${base(w)}/runs`).set('Authorization', `Bearer ${staff}`).send({}).expect(403);
    const latest = await api().get(`${base(w)}/runs/latest`).set('Authorization', `Bearer ${staff}`).expect(200);
    expect(latest.body).toMatchObject({ trigger: 'MANUAL', status: 'COMPLETED' });
  });

  it('D8: overlapping runs of the same scope are refused (409) and a crashed run is reclaimed', async () => {
    const w = await buildWorld(prisma);
    await prisma.billingReconciliationRun.create({ data: { studioId: w.studio.id, runScope: w.studio.id, trigger: 'CRON', status: 'RUNNING' } });
    const token = await login(app, w.owner.email, w.owner.password);
    await api().post(`${base(w)}/runs`).set('Authorization', `Bearer ${token}`).send({}).expect(409);
    await prisma.billingReconciliationRun.updateMany({ data: { startedAt: new Date(Date.now() - 4 * 3_600_000) } });
    await api().post(`${base(w)}/runs`).set('Authorization', `Bearer ${token}`).send({}).expect(200);
    expect(await prisma.billingReconciliationRun.count({ where: { status: 'FAILED' } })).toBe(1);
  });

  it('E1: alerts are log-only unless enabled; enabled, one alert per case per channel, idempotent across runs, escalated once the window passes', async () => {
    const w = await buildWorld(prisma, { fullStatus: SubscriptionStatus.PAST_DUE });
    stripeLists(w, [canceledInStripe(w)]);
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200 } as Response);

    await runs.runStudio(w.studio.id, 'MANUAL'); // disabled → suppressed
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await cases(w.studio.id))[0]!.lastAlertedAt).toBeNull();

    process.env['BILLING_ALERTS_ENABLED'] = 'true';
    process.env['BILLING_ALERT_WEBHOOK_URL'] = 'https://alerts.example.test/hook';
    process.env['BILLING_ALERT_ADMIN_BASE_URL'] = 'https://admin.example.test';
    const run = await runs.runStudio(w.studio.id, 'MANUAL');
    expect(run.alerts).toMatchObject({ considered: 1, sent: 1, failed: 0, channels: ['webhook'] });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string) as { text: string; gymos: Record<string, unknown> };
    expect(body.text).toMatch(/^Stripe canceló Full Access, pero GymOS la muestra como «PAST_DUE»/);
    expect(body.text).toMatch(/Categoría: Stripe canceló; GymOS la mantiene vigente · Severidad: Alto/);
    expect(body.text).toMatch(/Miembro: Fixture M\./);
    expect(body.text).toMatch(/Ver en Admin: https:\/\/admin\.example\.test\/members\//);
    expect(body.text).not.toContain('@');
    expect(body.gymos).toMatchObject({ severity: 'HIGH', escalation: false, studioId: w.studio.id });
    const afterFirst = (await cases(w.studio.id))[0]!;
    expect(afterFirst).toMatchObject({ alertCount: 1 });
    expect(afterFirst.lastAlertedAt).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { studioId: w.studio.id, action: 'BILLING_ALERT_SENT' } })).toBe(1);

    // Same run again within the escalation window: nothing new.
    const quiet = await runs.runStudio(w.studio.id, 'MANUAL');
    expect(quiet.alerts).toMatchObject({ considered: 0, sent: 0 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Window passes without acknowledgement → one escalation.
    await prisma.billingReconciliationCase.update({ where: { id: afterFirst.id }, data: { lastAlertedAt: new Date(Date.now() - 25 * 3_600_000) } });
    const escalated = await runs.runStudio(w.studio.id, 'MANUAL');
    expect(escalated.alerts).toMatchObject({ sent: 1 });
    const escBody = JSON.parse((fetchSpy.mock.calls[1]![1] as RequestInit).body as string) as { text: string; gymos: Record<string, unknown> };
    expect(escBody.text).toMatch(/^\[ESCALACIÓN\]/);
    expect((await cases(w.studio.id))[0]).toMatchObject({ alertCount: 2 });
    expect((await cases(w.studio.id))[0]!.escalatedAt).not.toBeNull();

    // Acknowledged cases never escalate.
    await prisma.billingReconciliationCase.update({ where: { id: afterFirst.id }, data: { status: 'ACKNOWLEDGED', lastAlertedAt: new Date(Date.now() - 50 * 3_600_000) } });
    const acked = await runs.runStudio(w.studio.id, 'MANUAL');
    expect(acked.alerts).toMatchObject({ considered: 0 });
  });

  it('E2: a failing provider never breaks the run; the failure is recorded on the case and retried next run; MEDIUM is below the default threshold', async () => {
    const w = await buildWorld(prisma, { fullStatus: SubscriptionStatus.PAST_DUE });
    stripeLists(w, [canceledInStripe(w)]);
    process.env['BILLING_ALERTS_ENABLED'] = 'true';
    process.env['BILLING_ALERT_WEBHOOK_URL'] = 'https://alerts.example.test/hook';
    const fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValue({ ok: true, status: 200 } as Response);
    const failing = await runs.runStudio(w.studio.id, 'MANUAL');
    expect(failing.status).toBe('COMPLETED');
    expect(failing.alerts).toMatchObject({ sent: 0, failed: 1 });
    const c = (await cases(w.studio.id))[0]!;
    expect(c.lastAlertedAt).toBeNull();
    expect((c.history as Array<{ type: string }>).some((h) => h.type === 'ALERT_FAILED')).toBe(true);
    const retry = await runs.runStudio(w.studio.id, 'MANUAL');
    expect(retry.alerts).toMatchObject({ sent: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Severity threshold: a MEDIUM case alone is not alerted by default, but is with MIN_SEVERITY=MEDIUM.
    await prisma.billingReconciliationCase.update({ where: { id: c.id }, data: { severity: 'MEDIUM', lastAlertedAt: null, alertCount: 0 } });
    expect(await alerts.pendingAlerts(new Date(), w.studio.id)).toHaveLength(0);
    process.env['BILLING_ALERT_MIN_SEVERITY'] = 'MEDIUM';
    expect(await alerts.pendingAlerts(new Date(), w.studio.id)).toHaveLength(1);
  });
});
