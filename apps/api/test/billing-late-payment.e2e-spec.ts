import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentMethod, PaymentStatus, SubscriptionEndReason, SubscriptionSource, SubscriptionStatus } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { StripeService } from '../src/stripe/stripe.service';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import { buildWorld, login, signedPost, stripeMutationCalls, type ReliabilityWorld } from './helpers/billing-reliability';

/**
 * Late-payment policy (Problem B), end to end: real dahlia invoice payloads, real Postgres.
 * The money is always recorded; entitlement and operator visibility follow the policy.
 */
describe('Billing reliability — paid invoices without valid entitlements (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let stripe: Record<string, jest.Mock>;
  let webhookSecret: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    stripe = app.get(StripeService) as unknown as Record<string, jest.Mock>;
    webhookSecret = app.get(ConfigService).getOrThrow<string>('STRIPE_WEBHOOK_SECRET');
  });

  afterAll(async () => {
    await truncateAll(prisma);
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    jest.clearAllMocks();
    stripe['listSubscriptionsForCustomer'].mockResolvedValue([]);
    stripe['findPaidInvoicePaymentIntentId'].mockResolvedValue(null);
    stripe['findInvoiceIdForPaymentIntent'].mockResolvedValue(null);
    process.env['BILLING_END_REASON_V2'] = 'true';
  });

  afterEach(() => {
    delete process.env['BILLING_END_REASON_V2'];
  });

  const post = (e: Parameters<typeof signedPost>[2]) => signedPost(app, webhookSecret, e);
  const row = (w: ReliabilityWorld) => prisma.subscription.findUniqueOrThrow({ where: { id: w.sub.id } });
  const payments = (invoiceId: string) => prisma.payment.findMany({ where: { stripeInvoiceId: invoiceId } });
  const cases = (studioId: string) => prisma.billingReconciliationCase.findMany({ where: { studioId }, orderBy: { createdAt: 'asc' } });
  const stripeSays = (status: string, id = 'sub_fx_full') => stripe['retrieveSubscription'].mockResolvedValue({ id, object: 'subscription', status, cancellation_details: { reason: status === 'canceled' ? 'payment_failed' : null }, metadata: {}, items: { data: [] } });
  /** The sanitized monthly fixture's `status_transitions.paid_at` (Oct 6, 2026). */
  const FIXTURE_PAID_AT = new Date('2026-10-06T17:41:08.000Z');
  /** Before the deletion fixture's Stripe `ended_at` (Sep 28, 2026 02:14:01Z). */
  const SEP_20_UNIX = Math.floor(Date.UTC(2026, 8, 20, 12, 0, 0) / 1000);
  const bootyRow = (w: ReliabilityWorld, data: Partial<{ status: SubscriptionStatus; endReason: SubscriptionEndReason | null }> = {}) =>
    prisma.subscription.create({ data: { studioId: w.studio.id, userId: w.member.id, membershipPlanId: w.booty.id, status: data.status ?? SubscriptionStatus.ACTIVE, endReason: data.endReason ?? null, source: SubscriptionSource.STRIPE, stripeSubscriptionId: 'sub_fx_booty_member', exclusiveGroupKey: null, currentPeriodStart: new Date('2026-08-18T16:54:40.000Z'), currentPeriodEnd: new Date('2026-10-02T16:54:40.000Z'), entitlementEndsAt: new Date('2026-10-02T16:54:40.000Z') } });

  it('A/H: a renewal paid on an active monthly membership records the payment and opens no case', async () => {
    const w = await buildWorld(prisma);
    await post(w.monthlyPaidInvoice()).expect(200);
    expect(await payments('in_fx0006')).toHaveLength(1);
    expect((await payments('in_fx0006'))[0]).toMatchObject({ status: PaymentStatus.SUCCEEDED, amountCents: 60000, subscriptionId: w.sub.id });
    expect(await cases(w.studio.id)).toHaveLength(0);
    expect(stripe['retrieveSubscription']).not.toHaveBeenCalled();
  });

  it('C: the production shape — Stripe canceled for non-payment, then the open renewal invoice is paid: money recorded, no access restored, CRITICAL case', async () => {
    const w = await buildWorld(prisma);
    await post(w.subscriptionEvent({ type: 'customer.subscription.deleted' })).expect(200);
    await post(w.lateFailedInvoice()).expect(200); // the late failure (already guarded) stays CANCELED
    expect(await row(w)).toMatchObject({ status: SubscriptionStatus.CANCELED, endReason: SubscriptionEndReason.PAYMENT_FAILED });

    stripeSays('canceled');
    await post(w.monthlyPaidInvoice({ invoiceId: 'in_fx0032', paidAt: w.nowUnix() })).expect(200); // the invoice the deletion named as latest_invoice, paid later

    const after = await row(w);
    expect(after).toMatchObject({ status: SubscriptionStatus.CANCELED, entitlementEndsAt: null, currentPeriodEnd: w.sub.currentPeriodEnd });
    const [payment] = await payments('in_fx0032');
    expect(payment).toMatchObject({ status: PaymentStatus.SUCCEEDED, amountCents: 60000 });
    const [c] = await cases(w.studio.id);
    expect(c).toMatchObject({
      category: 'PAID_WITHOUT_ENTITLEMENT', severity: 'CRITICAL', status: 'OPEN', reasonCode: 'SUBSCRIPTION_ENDED',
      userId: w.member.id, subscriptionId: w.sub.id, paymentId: payment!.id, stripeInvoiceId: 'in_fx0032', stripeSubscriptionId: 'sub_fx_full',
    });
    expect(c!.title).toMatch(/Pago recibido sin acceso/);
    // The real line period of the sanitized monthly fixture (Oct 2 → Nov 2, 2026).
    expect(c!.evidence).toMatchObject({ amountCents: 60000, currency: 'mxn', entitlementGranted: false, whyNotGranted: 'SUBSCRIPTION_ENDED', stripeStatus: 'canceled', localStatus: 'CANCELED', servicePeriodStart: new Date(1790966360 * 1000).toISOString(), servicePeriodEnd: new Date(1793644760 * 1000).toISOString() });
    expect(c!.suggestedAction).toMatch(/No reactives la suscripción cancelada/);
    expect(stripeMutationCalls(stripe)).toBe(0);
    expect(await prisma.stripeWebhookEvent.findFirstOrThrow({ where: { eventType: 'invoice.paid' } })).toMatchObject({ processed: true });
  });

  it('a replayed invoice.paid for a period paid WHILE the membership was live is ordinary: no case, no cry-wolf alert', async () => {
    const w = await buildWorld(prisma);
    await post(w.subscriptionEvent({ type: 'customer.subscription.deleted' })).expect(200);
    stripeSays('canceled');
    // Paid Sep 20, before the fixture's Stripe `ended_at` (Sep 28 02:14:01Z): the period was consumed live.
    await post(w.monthlyPaidInvoice({ invoiceId: 'in_fx_replayed', paidAt: SEP_20_UNIX })).expect(200);
    expect((await payments('in_fx_replayed'))[0]).toMatchObject({ status: PaymentStatus.SUCCEEDED });
    expect(await cases(w.studio.id)).toHaveLength(0);
    expect((await row(w)).status).toBe(SubscriptionStatus.CANCELED);
  });

  it('"while live" is decided on Stripe\'s clock: a deletion GymOS stored late cannot hide a payment made after the membership ended', async () => {
    const w = await buildWorld(prisma);
    // The deletion row is stored NOW (Oct 2026) but Stripe ended the subscription on Sep 28 (`ended_at`);
    // the fixture invoice was paid Oct 6 — after the end, before GymOS received the deletion.
    await post(w.subscriptionEvent({ type: 'customer.subscription.deleted' })).expect(200);
    const deletion = await prisma.stripeWebhookEvent.findFirstOrThrow({ where: { eventType: 'customer.subscription.deleted' } });
    expect(deletion.createdAt.getTime()).toBeGreaterThan(FIXTURE_PAID_AT.getTime());
    stripeSays('canceled');
    await post(w.monthlyPaidInvoice({ invoiceId: 'in_fx_late_stored' })).expect(200);
    expect((await payments('in_fx_late_stored'))[0]).toMatchObject({ status: PaymentStatus.SUCCEEDED, paidAt: FIXTURE_PAID_AT });
    const [c] = await cases(w.studio.id);
    expect(c).toMatchObject({ category: 'PAID_WITHOUT_ENTITLEMENT', severity: 'CRITICAL', reasonCode: 'SUBSCRIPTION_ENDED', stripeInvoiceId: 'in_fx_late_stored' });
    expect(await row(w)).toMatchObject({ status: SubscriptionStatus.CANCELED, entitlementEndsAt: null });
  });

  it('C (Stripe alive): the same payment while Stripe keeps the subscription active is CRITICAL with the GymOS-side reason', async () => {
    const w = await buildWorld(prisma, { fullStatus: SubscriptionStatus.CANCELED });
    await prisma.subscription.update({ where: { id: w.sub.id }, data: { endReason: SubscriptionEndReason.STAFF_CANCELLED } });
    stripeSays('active');
    await post(w.monthlyPaidInvoice({ paidAt: w.nowUnix() })).expect(200);
    expect((await row(w)).status).toBe(SubscriptionStatus.CANCELED);
    expect((await cases(w.studio.id))[0]).toMatchObject({ category: 'PAID_WITHOUT_ENTITLEMENT', severity: 'CRITICAL', reasonCode: 'LOCAL_CANCELED_STRIPE_ALIVE' });
  });

  it('D: a failed invoice later paid flips the Payment to SUCCEEDED on a PAST_DUE row and opens no case', async () => {
    const w = await buildWorld(prisma);
    await post(w.subscriptionEvent({ type: 'customer.subscription.updated', status: 'past_due' })).expect(200);
    const failed = w.lateFailedInvoice();
    failed.data.object.id = 'in_fx0006';
    await post(failed).expect(200);
    expect((await payments('in_fx0006'))[0]).toMatchObject({ status: PaymentStatus.FAILED });
    expect((await row(w)).status).toBe(SubscriptionStatus.PAST_DUE);
    await post(w.monthlyPaidInvoice()).expect(200);
    expect(await payments('in_fx0006')).toHaveLength(1);
    expect((await payments('in_fx0006'))[0]).toMatchObject({ status: PaymentStatus.SUCCEEDED, amountCents: 60000 });
    expect(await cases(w.studio.id)).toHaveLength(0);
  });

  it('J: a second invoice.paid for the same invoice (new event id) is idempotent: one Payment, no case, no double credit', async () => {
    const w = await buildWorld(prisma);
    await post(w.monthlyPaidInvoice({ id: 'evt_paid_a' })).expect(200);
    await post(w.monthlyPaidInvoice({ id: 'evt_paid_b' })).expect(200);
    expect(await payments('in_fx0006')).toHaveLength(1);
    expect(await cases(w.studio.id)).toHaveLength(0);
    // Also for a fixed-duration renewal: exactly one 45-day cycle.
    const bootySub = await bootyRow(w);
    await post(w.bootyPaidInvoice({ id: 'evt_booty_a' })).expect(200);
    await post(w.bootyPaidInvoice({ id: 'evt_booty_b' })).expect(200);
    expect(await prisma.membershipEntitlementCycle.count({ where: { subscriptionId: bootySub.id } })).toBe(1);
    expect(await payments('in_fx_booty_renewal')).toHaveLength(1);
  });

  it('J needs the cycle, not just the Payment: replaying a recorded invoice whose grant failed repairs a live row', async () => {
    const w = await buildWorld(prisma);
    const bootySub = await bootyRow(w);
    // Incident A shape: the money was recorded, the cycle never existed (grant failed / dead-lettered).
    // The ledger is immutable (DB trigger), so the shape is built directly rather than by deleting a cycle.
    await prisma.payment.create({ data: { studioId: w.studio.id, userId: w.member.id, subscriptionId: bootySub.id, membershipPlanId: w.booty.id, amountCents: 80000, currency: 'mxn', status: PaymentStatus.SUCCEEDED, paymentMethod: PaymentMethod.STRIPE, stripeInvoiceId: 'in_fx_booty_renewal', paidAt: new Date('2026-10-02T17:55:59.000Z') } });
    await post(w.bootyPaidInvoice({ id: 'evt_booty_replay_live' })).expect(200);
    expect(await prisma.membershipEntitlementCycle.count({ where: { subscriptionId: bootySub.id, stripeInvoiceId: 'in_fx_booty_renewal' } })).toBe(1);
    expect(await payments('in_fx_booty_renewal')).toHaveLength(1);
    expect(await cases(w.studio.id)).toHaveLength(0);
  });

  it('J needs the cycle, not just the Payment: the same replay on a CANCELED row next to a newer cash membership never opens a second window', async () => {
    const w = await buildWorld(prisma);
    const bootySub = await bootyRow(w, { status: SubscriptionStatus.CANCELED, endReason: SubscriptionEndReason.PAYMENT_FAILED });
    await prisma.payment.create({ data: { studioId: w.studio.id, userId: w.member.id, subscriptionId: bootySub.id, membershipPlanId: w.booty.id, amountCents: 80000, currency: 'mxn', status: PaymentStatus.SUCCEEDED, paymentMethod: PaymentMethod.STRIPE, stripeInvoiceId: 'in_fx_booty_renewal', paidAt: new Date('2026-10-02T17:55:59.000Z') } });
    const cash = await prisma.subscription.create({ data: { studioId: w.studio.id, userId: w.member.id, membershipPlanId: w.booty.id, status: SubscriptionStatus.ACTIVE, source: SubscriptionSource.CASH, exclusiveGroupKey: null, currentPeriodStart: new Date(Date.now() - 86400e3), currentPeriodEnd: new Date(Date.now() + 30 * 86400e3), entitlementEndsAt: new Date(Date.now() + 30 * 86400e3), cancelAtPeriodEnd: true } });
    stripeSays('canceled', 'sub_fx_booty_member');
    // The product's own suggested repair ("reenvía el invoice.paid") must not double-cover the member.
    await post(w.bootyPaidInvoice({ id: 'evt_booty_replay_canceled' })).expect(200);
    expect(await prisma.membershipEntitlementCycle.count({ where: { subscriptionId: bootySub.id } })).toBe(0);
    expect(await prisma.membershipEntitlementCycle.count({ where: { subscriptionId: cash.id } })).toBe(0);
    expect(await payments('in_fx_booty_renewal')).toHaveLength(1);
    expect((await cases(w.studio.id))[0]).toMatchObject({ category: 'PAID_WITHOUT_ENTITLEMENT', severity: 'CRITICAL', reasonCode: 'DUPLICATE_MEMBERSHIP_PAYMENT', stripeInvoiceId: 'in_fx_booty_renewal' });
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: bootySub.id } })).toMatchObject({ status: SubscriptionStatus.CANCELED, entitlementEndsAt: new Date('2026-10-02T16:54:40.000Z') });
    expect(stripeMutationCalls(stripe)).toBe(0);
  });

  it('E: a payment for a membership GymOS already replaced grants nothing and is CRITICAL (no dead-letter loop), even on redelivery', async () => {
    const w = await buildWorld(prisma, { fullStatus: SubscriptionStatus.CANCELED });
    // Stripe ended the card subscription on Sep 28 (fixture `ended_at`) when GymOS moved the member to cash.
    await post(w.subscriptionEvent({ type: 'customer.subscription.deleted' })).expect(200);
    const successor = await prisma.subscription.create({ data: { studioId: w.studio.id, userId: w.member.id, membershipPlanId: w.full.id, status: SubscriptionStatus.ACTIVE, source: SubscriptionSource.CASH, exclusiveGroupKey: 'CORE', currentPeriodStart: new Date('2026-10-01T00:00:00Z'), currentPeriodEnd: new Date('2026-11-01T00:00:00Z'), cancelAtPeriodEnd: true } });
    await prisma.subscription.update({ where: { id: w.sub.id }, data: { endReason: SubscriptionEndReason.SUPERSEDED_PAYMENT_METHOD, supersededBySubscriptionId: successor.id } });
    stripeSays('active');
    await post(w.monthlyPaidInvoice({ id: 'evt_superseded', paidAt: w.nowUnix() })).expect(200);
    expect((await cases(w.studio.id))[0]).toMatchObject({ category: 'PAID_WITHOUT_ENTITLEMENT', severity: 'CRITICAL', reasonCode: 'SUPERSEDED_MEMBERSHIP' });
    expect(await prisma.stripeWebhookEvent.findUniqueOrThrow({ where: { stripeEventId: 'evt_superseded' } })).toMatchObject({ processed: true, lastError: null });
    await post(w.monthlyPaidInvoice({ id: 'evt_superseded_again', paidAt: w.nowUnix() })).expect(200);
    expect(await cases(w.studio.id)).toHaveLength(1);
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: successor.id } })).toMatchObject({ status: SubscriptionStatus.ACTIVE }); // untouched
    // The last invoice of the card period, paid Sep 20 while that row was live, delivered (or replayed)
    // after the handoff: money recorded, nothing granted, and no cry-wolf CRITICAL.
    await post(w.monthlyPaidInvoice({ id: 'evt_superseded_live_period', invoiceId: 'in_fx_live_period', paidAt: SEP_20_UNIX })).expect(200);
    expect((await payments('in_fx_live_period'))[0]).toMatchObject({ status: PaymentStatus.SUCCEEDED });
    expect(await cases(w.studio.id)).toHaveLength(1);
    expect(await prisma.stripeWebhookEvent.findUniqueOrThrow({ where: { stripeEventId: 'evt_superseded_live_period' } })).toMatchObject({ processed: true, lastError: null });
  });

  it('G late: a fixed-duration renewal paid after Stripe canceled grants exactly its paid window, keeps the row CANCELED, and is visible (MEDIUM)', async () => {
    const w = await buildWorld(prisma);
    const bootySub = await bootyRow(w, { status: SubscriptionStatus.CANCELED, endReason: SubscriptionEndReason.PAYMENT_FAILED });
    stripeSays('canceled', 'sub_fx_booty_member');
    await post(w.bootyPaidInvoice({ paidAt: w.nowUnix() })).expect(200);
    const cycles = await prisma.membershipEntitlementCycle.findMany({ where: { subscriptionId: bootySub.id } });
    expect(cycles.map((c) => [c.startsAt.toISOString(), c.endsAt.toISOString(), c.creditLimit])).toEqual([['2026-10-02T16:54:40.000Z', '2026-11-16T16:54:40.000Z', 4]]);
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: bootySub.id } })).toMatchObject({ status: SubscriptionStatus.CANCELED, entitlementEndsAt: new Date('2026-11-16T16:54:40.000Z') });
    expect((await cases(w.studio.id))[0]).toMatchObject({ category: 'PAID_WITHOUT_ENTITLEMENT', severity: 'MEDIUM', reasonCode: 'LATE_FIXED_WINDOW_GRANTED' });
    expect((await cases(w.studio.id))[0]!.evidence).toMatchObject({ entitlementGranted: true });
  });

  it('G late with a newer same-plan membership already covering the member: no second window, CRITICAL duplicate-payment case', async () => {
    const w = await buildWorld(prisma);
    const bootySub = await bootyRow(w, { status: SubscriptionStatus.CANCELED, endReason: SubscriptionEndReason.PAYMENT_FAILED });
    // Staff sold a cash Booty Lab after Stripe canceled the card one (not linked as a supersession).
    const cash = await prisma.subscription.create({ data: { studioId: w.studio.id, userId: w.member.id, membershipPlanId: w.booty.id, status: SubscriptionStatus.ACTIVE, source: SubscriptionSource.CASH, exclusiveGroupKey: null, currentPeriodStart: new Date(Date.now() - 86400e3), currentPeriodEnd: new Date(Date.now() + 30 * 86400e3), entitlementEndsAt: new Date(Date.now() + 30 * 86400e3), cancelAtPeriodEnd: true } });
    stripeSays('canceled', 'sub_fx_booty_member');
    await post(w.bootyPaidInvoice({ paidAt: w.nowUnix() })).expect(200);
    expect(await prisma.membershipEntitlementCycle.count({ where: { subscriptionId: bootySub.id } })).toBe(0);
    expect(await prisma.membershipEntitlementCycle.count({ where: { subscriptionId: cash.id } })).toBe(0);
    expect((await payments('in_fx_booty_renewal'))[0]).toMatchObject({ status: PaymentStatus.SUCCEEDED, amountCents: 80000 });
    expect((await cases(w.studio.id))[0]).toMatchObject({ category: 'PAID_WITHOUT_ENTITLEMENT', severity: 'CRITICAL', reasonCode: 'DUPLICATE_MEMBERSHIP_PAYMENT' });
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: bootySub.id } })).toMatchObject({ status: SubscriptionStatus.CANCELED, entitlementEndsAt: new Date('2026-10-02T16:54:40.000Z') });
  });

  it('UNATTRIBUTED: a renewal invoice for a subscription GymOS does not have is CRITICAL; a first-purchase invoice racing its row is not', async () => {
    const w = await buildWorld(prisma);
    await prisma.subscription.delete({ where: { id: w.sub.id } });
    stripe['retrieveSubscription'].mockResolvedValue({ id: 'sub_fx_full', status: 'active', metadata: w.fullMetadata, items: { data: [{ price: { id: 'price_fx_full' } }] } });
    await post(w.monthlyPaidInvoice({ id: 'evt_orphan_cycle' })).expect(200);
    expect((await cases(w.studio.id))[0]).toMatchObject({ category: 'PAID_WITHOUT_ENTITLEMENT', severity: 'CRITICAL', reasonCode: 'NO_LOCAL_SUBSCRIPTION', userId: w.member.id });
    await post(w.monthlyPaidInvoice({ id: 'evt_orphan_create', invoiceId: 'in_first', billingReason: 'subscription_create' })).expect(200);
    expect(await cases(w.studio.id)).toHaveLength(1);
  });

  it('I: a refund is mirrored into the Payment and a case, matched through the PaymentIntent (no `invoice` on basil charges), without touching access; a dispute is HIGH', async () => {
    const w = await buildWorld(prisma);
    await post(w.monthlyPaidInvoice()).expect(200);
    // The Payment has no PaymentIntent id (dahlia invoices embed none): the InvoicePayment lookup resolves it.
    stripe['findInvoiceIdForPaymentIntent'].mockImplementation(async (pi: string) => (pi === 'pi_fx_1' ? 'in_fx0006' : null));
    await post(w.chargeRefunded({ chargeId: 'ch_fx_1', amount: 60000, amountRefunded: 60000, paymentIntent: 'pi_fx_1' })).expect(200);
    expect((await payments('in_fx0006'))[0]).toMatchObject({ status: PaymentStatus.REFUNDED });
    expect((await row(w)).status).toBe(SubscriptionStatus.ACTIVE); // access is an operator decision
    // A redelivered invoice.paid (Stripe retry, operator resend) must not undo the mirrored refund.
    await post(w.monthlyPaidInvoice({ id: 'evt_paid_redelivered_after_refund' })).expect(200);
    expect((await payments('in_fx0006'))[0]).toMatchObject({ status: PaymentStatus.REFUNDED, amountCents: 60000 });
    const [refund] = await cases(w.studio.id);
    expect(refund).toMatchObject({ category: 'PAYMENT_REFUNDED_OR_DISPUTED', severity: 'MEDIUM', reasonCode: 'REFUNDED', stripeInvoiceId: 'in_fx0006', issueKey: `${w.studio.id}:PAYMENT_REFUNDED_OR_DISPUTED:ch_fx_1` });
    // An unmatched charge (unknown PaymentIntent) is logged, not guessed.
    await post(w.chargeRefunded({ chargeId: 'ch_fx_unknown', amount: 60000, amountRefunded: 60000, paymentIntent: 'pi_unknown' })).expect(200);
    expect(await cases(w.studio.id)).toHaveLength(1);

    await prisma.payment.update({ where: { stripeInvoiceId: 'in_fx0006' }, data: { stripePaymentIntentId: 'pi_fx_1' } });
    await post(w.chargeDisputed({ disputeId: 'dp_fx_1', chargeId: 'ch_fx_1', paymentIntent: 'pi_fx_1', amount: 60000 })).expect(200);
    const all = await cases(w.studio.id);
    expect(all.map((c) => [c.reasonCode, c.severity])).toEqual([['REFUNDED', 'MEDIUM'], ['DISPUTED', 'HIGH']]);
  });

  it('staff override: cancelling a Stripe-backed row records STAFF_CANCELLED + audit + a HIGH case while Stripe bills; re-cancelling never overwrites an involuntary reason', async () => {
    const w = await buildWorld(prisma);
    const token = await login(app, w.owner.email, w.owner.password);
    stripeSays('active');
    await request(app.getHttpServer()).patch(`/api/v1/studios/${w.studio.id}/members/${w.member.id}/subscriptions/${w.sub.id}/status`).set('Authorization', `Bearer ${token}`).send({ status: 'CANCELED' }).expect(200);
    expect(await row(w)).toMatchObject({ status: SubscriptionStatus.CANCELED, endReason: SubscriptionEndReason.STAFF_CANCELLED });
    expect(await prisma.auditLog.findFirst({ where: { action: 'SUBSCRIPTION_STATUS_OVERRIDDEN', entityId: w.sub.id } })).toMatchObject({ actorUserId: w.owner.id, targetUserId: w.member.id });
    expect((await cases(w.studio.id))[0]).toMatchObject({ category: 'LOCAL_CANCELED_STRIPE_ALIVE', severity: 'HIGH', reasonCode: 'STAFF_LOCAL_CANCEL', subscriptionId: w.sub.id });

    // Rollout gate OFF (day-one production default): the same action records the legacy value.
    delete process.env['BILLING_END_REASON_V2'];
    const gated = await buildWorld(prisma, { suffix: '_gate' });
    const tokenG = await login(app, gated.owner.email, gated.owner.password);
    await request(app.getHttpServer()).patch(`/api/v1/studios/${gated.studio.id}/members/${gated.member.id}/subscriptions/${gated.sub.id}/status`).set('Authorization', `Bearer ${tokenG}`).send({ status: 'CANCELED' }).expect(200);
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: gated.sub.id } })).toMatchObject({ status: SubscriptionStatus.CANCELED, endReason: SubscriptionEndReason.MEMBER_CANCELLED });
    process.env['BILLING_END_REASON_V2'] = 'true';

    const ended = await buildWorld(prisma, { fullStatus: SubscriptionStatus.CANCELED, suffix: '_b' });
    await prisma.subscription.update({ where: { id: ended.sub.id }, data: { endReason: SubscriptionEndReason.PAYMENT_FAILED } });
    const tokenB = await login(app, ended.owner.email, ended.owner.password);
    await request(app.getHttpServer()).patch(`/api/v1/studios/${ended.studio.id}/members/${ended.member.id}/subscriptions/${ended.sub.id}/status`).set('Authorization', `Bearer ${tokenB}`).send({ status: 'CANCELED' }).expect(200);
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: ended.sub.id } })).toMatchObject({ endReason: SubscriptionEndReason.PAYMENT_FAILED });
    expect(await cases(ended.studio.id)).toHaveLength(0);
  });

  it('Member 360 exposes the open case and the card copy never says "Al corriente" for it', async () => {
    const w = await buildWorld(prisma);
    await post(w.subscriptionEvent({ type: 'customer.subscription.deleted' })).expect(200);
    stripeSays('canceled');
    await post(w.monthlyPaidInvoice({ invoiceId: 'in_fx0032', paidAt: w.nowUnix() })).expect(200);
    const token = await login(app, w.owner.email, w.owner.password);
    const res = await request(app.getHttpServer()).get(`/api/v1/studios/${w.studio.id}/members/${w.member.id}/billing-status`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.openCases).toHaveLength(1);
    expect(res.body.openCases[0]).toMatchObject({ category: 'PAID_WITHOUT_ENTITLEMENT', severity: 'CRITICAL', status: 'OPEN', subscriptionId: w.sub.id, stripeInvoiceId: 'in_fx0032' });
    expect(res.body.openCases[0].title).toMatch(/Pago recibido sin acceso/);
    // Another studio's staff cannot see it through the member endpoint either.
    const otherStudio = await buildWorld(prisma, { suffix: '_other' });
    const otherToken = await login(app, otherStudio.owner.email, otherStudio.owner.password);
    await request(app.getHttpServer()).get(`/api/v1/studios/${otherStudio.studio.id}/members/${w.member.id}/billing-status`).set('Authorization', `Bearer ${otherToken}`).expect(404);
  });
});
