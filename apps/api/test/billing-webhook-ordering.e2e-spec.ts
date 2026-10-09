import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient, SubscriptionEndReason, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { StripeService } from '../src/stripe/stripe.service';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import { buildWorld, signedPost, stripeMutationCalls, type ReliabilityWorld } from './helpers/billing-reliability';

/**
 * Out-of-order `customer.subscription.*` protection (Incident B class), end to end on real
 * Postgres: real signature verification, real advisory locks, real unique indexes. Stripe HTTP is
 * mocked; `retrieveSubscription` is the GET the guard uses as its tie-breaker.
 */
describe('Billing reliability — subscription event ordering (e2e)', () => {
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
    delete process.env['BILLING_STALE_EVENT_GUARD'];
  });

  const post = (e: Parameters<typeof signedPost>[2]) => signedPost(app, webhookSecret, e);
  const row = (w: ReliabilityWorld) => prisma.subscription.findUniqueOrThrow({ where: { id: w.sub.id } });
  const stripeSays = (status: string, reason: string | null = status === 'canceled' ? 'payment_failed' : null) =>
    stripe['retrieveSubscription'].mockResolvedValue({ id: 'sub_fx_full', object: 'subscription', status, cancellation_details: { reason }, metadata: {}, items: { data: [] } });

  it('A1: deletion followed by a stale "active" update stays CANCELED; the stale event is processed, not retried, and writes nothing', async () => {
    const w = await buildWorld(prisma);
    await post(w.subscriptionEvent({ type: 'customer.subscription.deleted', id: 'evt_del' })).expect(200);
    expect(await row(w)).toMatchObject({ status: SubscriptionStatus.CANCELED, endReason: SubscriptionEndReason.PAYMENT_FAILED });
    const before = await row(w);

    stripeSays('canceled');
    await post(w.subscriptionEvent({ type: 'customer.subscription.updated', status: 'active', id: 'evt_stale', created: 1790561640 })).expect(200);

    const after = await row(w);
    expect(after).toEqual(before); // byte-identical: no field was rewritten, not even updatedAt
    expect(await prisma.stripeWebhookEvent.findUniqueOrThrow({ where: { stripeEventId: 'evt_stale' } })).toMatchObject({ processed: true, lastError: null });
    // The guard's GET is bounded (request-path timeout), never the SDK's 80 s default.
    expect(stripe['retrieveSubscription']).toHaveBeenCalledWith('sub_fx_full', expect.objectContaining({ timeoutMs: expect.any(Number) }));
    expect(stripeMutationCalls(stripe)).toBe(0);
  });

  it('A2: update followed by deletion ends CANCELED with the involuntary reason', async () => {
    const w = await buildWorld(prisma);
    await post(w.subscriptionEvent({ type: 'customer.subscription.updated', status: 'past_due' })).expect(200);
    expect((await row(w)).status).toBe(SubscriptionStatus.PAST_DUE);
    await post(w.subscriptionEvent({ type: 'customer.subscription.deleted' })).expect(200);
    expect(await row(w)).toMatchObject({ status: SubscriptionStatus.CANCELED, endReason: SubscriptionEndReason.PAYMENT_FAILED, cancelAtPeriodEnd: false });
  });

  it('A3: concurrent update + deletion converge on CANCELED in every interleaving; a retried delivery still cannot resurrect', async () => {
    const w = await buildWorld(prisma);
    stripeSays('canceled');
    const stale = w.subscriptionEvent({ type: 'customer.subscription.updated', status: 'active', id: 'evt_conc_stale' });
    const deleted = w.subscriptionEvent({ type: 'customer.subscription.deleted', id: 'evt_conc_del' });
    const [a, b] = await Promise.all([post(stale), post(deleted)]);
    expect(b.status).toBe(200);
    // The stale update either applied first (then the deletion overwrote it), was ignored after a
    // live check, or failed closed (500 → Stripe redelivers). Never a resurrection.
    expect([200, 500]).toContain(a.status);
    expect((await row(w)).status).toBe(SubscriptionStatus.CANCELED);
    if (a.status === 500) {
      await post(stale).expect(200); // redelivery: now verified against Stripe and ignored
    }
    expect((await row(w)).status).toBe(SubscriptionStatus.CANCELED);
    expect(await prisma.stripeWebhookEvent.findUniqueOrThrow({ where: { stripeEventId: 'evt_conc_stale' } })).toMatchObject({ processed: true });
  });

  it('A4: a duplicate deletion is idempotent (same end reason, no second audit, no error)', async () => {
    const w = await buildWorld(prisma);
    const first = w.subscriptionEvent({ type: 'customer.subscription.deleted', id: 'evt_dup_1' });
    const second = { ...first, id: 'evt_dup_2' };
    await post(first).expect(200);
    const afterFirst = await row(w);
    await post(second).expect(200);
    expect(await row(w)).toMatchObject({ status: SubscriptionStatus.CANCELED, endReason: afterFirst.endReason, updatedAt: afterFirst.updatedAt });
    await post(first).expect(200); // Stripe redelivery of the very same event id
    expect(await prisma.stripeWebhookEvent.count({ where: { stripeEventId: { in: ['evt_dup_1', 'evt_dup_2'] }, processed: true } })).toBe(2);
  });

  it('A5: cancel_at_period_end keeps the membership ACTIVE until the period ends (renewal off ≠ access off)', async () => {
    const w = await buildWorld(prisma);
    await post(w.subscriptionEvent({ type: 'customer.subscription.updated', status: 'active', cancelAtPeriodEnd: true, cancellationReason: 'cancellation_requested' })).expect(200);
    expect(await row(w)).toMatchObject({ status: SubscriptionStatus.ACTIVE, cancelAtPeriodEnd: true, currentPeriodEnd: w.sub.currentPeriodEnd, endReason: null });
    // Period end arrives: Stripe deletes with cancellation_requested → a requested cancellation, never a failure.
    await post(w.subscriptionEvent({ type: 'customer.subscription.deleted', cancelAtPeriodEnd: true, cancellationReason: 'cancellation_requested' })).expect(200);
    expect(await row(w)).toMatchObject({ status: SubscriptionStatus.CANCELED, endReason: SubscriptionEndReason.MEMBER_CANCELLED });
  });

  it('A6: legitimate recovery and status changes on a live subscription still apply (PAST_DUE → ACTIVE, paused, trialing)', async () => {
    const w = await buildWorld(prisma, { fullStatus: SubscriptionStatus.PAST_DUE });
    await post(w.subscriptionEvent({ type: 'customer.subscription.updated', status: 'active', periodStart: 1791940347, periodEnd: 1794532347 })).expect(200);
    expect(await row(w)).toMatchObject({ status: SubscriptionStatus.ACTIVE, currentPeriodStart: new Date(1791940347 * 1000), currentPeriodEnd: new Date(1794532347 * 1000) });
    await post(w.subscriptionEvent({ type: 'customer.subscription.updated', status: 'paused' })).expect(200);
    expect((await row(w)).status).toBe(SubscriptionStatus.PAUSED);
    await post(w.subscriptionEvent({ type: 'customer.subscription.updated', status: 'active' })).expect(200);
    expect((await row(w)).status).toBe(SubscriptionStatus.ACTIVE);
    expect(stripe['retrieveSubscription']).not.toHaveBeenCalled(); // no terminal conflict → no live check
  });

  it('A7: a GymOS-side cancellation Stripe disagrees with is kept and becomes a HIGH case — never auto-reactivated', async () => {
    const w = await buildWorld(prisma, { fullStatus: SubscriptionStatus.CANCELED });
    await prisma.subscription.update({ where: { id: w.sub.id }, data: { endReason: SubscriptionEndReason.STAFF_CANCELLED } });
    stripeSays('active', null);
    await post(w.subscriptionEvent({ type: 'customer.subscription.updated', status: 'active', id: 'evt_local_cancel' })).expect(200);
    expect(await row(w)).toMatchObject({ status: SubscriptionStatus.CANCELED, endReason: SubscriptionEndReason.STAFF_CANCELLED });
    const cases = await prisma.billingReconciliationCase.findMany({ where: { studioId: w.studio.id } });
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ category: 'LOCAL_CANCELED_STRIPE_ALIVE', severity: 'HIGH', status: 'OPEN', subscriptionId: w.sub.id, stripeSubscriptionId: 'sub_fx_full', stripeEventId: 'evt_local_cancel' });
    // Redelivery observes the same case (no duplicate).
    await post(w.subscriptionEvent({ type: 'customer.subscription.updated', status: 'active', id: 'evt_local_cancel_2' })).expect(200);
    expect(await prisma.billingReconciliationCase.count({ where: { studioId: w.studio.id } })).toBe(1);
    expect((await prisma.billingReconciliationCase.findFirstOrThrow({ where: { studioId: w.studio.id } })).observationCount).toBe(2);
  });

  it('A8: when Stripe cannot be consulted the stale event fails closed (500, visible dead letter) and nothing is written', async () => {
    const w = await buildWorld(prisma, { fullStatus: SubscriptionStatus.CANCELED });
    stripe['retrieveSubscription'].mockRejectedValue(new Error('connect ETIMEDOUT'));
    const res = await post(w.subscriptionEvent({ type: 'customer.subscription.updated', status: 'active', id: 'evt_unverified' }));
    expect(res.status).toBe(500);
    expect((await row(w)).status).toBe(SubscriptionStatus.CANCELED);
    expect(await prisma.stripeWebhookEvent.findUniqueOrThrow({ where: { stripeEventId: 'evt_unverified' } })).toMatchObject({ processed: false, lastError: expect.stringContaining('stale-event guard could not verify') });
    // Stripe comes back: the redelivery is verified and ignored.
    stripeSays('canceled');
    await post(w.subscriptionEvent({ type: 'customer.subscription.updated', status: 'active', id: 'evt_unverified' })).expect(200);
    expect(await prisma.stripeWebhookEvent.findUniqueOrThrow({ where: { stripeEventId: 'evt_unverified' } })).toMatchObject({ processed: true });
  });

  it('A9: a subscription Stripe no longer knows ("No such subscription") counts as ended', async () => {
    const w = await buildWorld(prisma, { fullStatus: SubscriptionStatus.CANCELED });
    stripe['retrieveSubscription'].mockRejectedValue(new Error('No such subscription: sub_fx_full'));
    await post(w.subscriptionEvent({ type: 'customer.subscription.updated', status: 'active' })).expect(200);
    expect((await row(w)).status).toBe(SubscriptionStatus.CANCELED);
    expect(await prisma.billingReconciliationCase.count()).toBe(0);
  });

  it('A10: a brand-new, independently created subscription for the same member is never blocked by an old CANCELED row', async () => {
    const w = await buildWorld(prisma, { fullStatus: SubscriptionStatus.CANCELED });
    const created = w.subscriptionEvent({ type: 'customer.subscription.created', status: 'active' });
    created.data.object.id = 'sub_fx_full_v2';
    await post(created).expect(200);
    const rows = await prisma.subscription.findMany({ where: { userId: w.member.id }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => [r.stripeSubscriptionId, r.status])).toEqual([['sub_fx_full', 'CANCELED'], ['sub_fx_full_v2', 'ACTIVE']]);
    expect(stripe['retrieveSubscription']).not.toHaveBeenCalled();
  });

  it('E1: Stripe reasons map to involuntary end reasons; a dispute and a never-paid first invoice are not "member cancelled"', async () => {
    const disputed = await buildWorld(prisma);
    await post(disputed.subscriptionEvent({ type: 'customer.subscription.deleted', cancellationReason: 'payment_disputed' })).expect(200);
    expect((await row(disputed)).endReason).toBe(SubscriptionEndReason.PAYMENT_DISPUTED);
    const expired = await prisma.subscription.update({ where: { id: disputed.sub.id }, data: { status: SubscriptionStatus.PAUSED, endReason: null } });
    await post(disputed.subscriptionEvent({ type: 'customer.subscription.deleted', status: 'incomplete_expired', cancellationReason: null })).expect(200);
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: expired.id } })).toMatchObject({ status: SubscriptionStatus.CANCELED, endReason: SubscriptionEndReason.INCOMPLETE_EXPIRED });
  });

  it('E2: an end reason GymOS already recorded (e.g. a Stripe→cash supersession) is never overwritten by the deletion', async () => {
    const w = await buildWorld(prisma);
    await prisma.subscription.update({ where: { id: w.sub.id }, data: { endReason: SubscriptionEndReason.SUPERSEDED_PAYMENT_METHOD } });
    await post(w.subscriptionEvent({ type: 'customer.subscription.deleted', cancellationReason: 'payment_failed' })).expect(200);
    expect((await row(w)).endReason).toBe(SubscriptionEndReason.SUPERSEDED_PAYMENT_METHOD);
  });

  it('NEGATIVE CONTROL: the pre-guard unconditional update DOES resurrect a row canceled concurrently (what production ran on 2026-09-28)', async () => {
    const w = await buildWorld(prisma);
    const other = new PrismaClient();
    try {
      // A deletion transaction holds the row (status → CANCELED, not yet committed).
      let releaseDeletion!: () => void;
      const deletionCommitted = new Promise<void>((resolve) => { releaseDeletion = resolve; });
      const deletion = other.$transaction(async (tx) => {
        await tx.subscription.update({ where: { id: w.sub.id }, data: { status: SubscriptionStatus.CANCELED, endReason: SubscriptionEndReason.PAYMENT_FAILED } });
        await deletionCommitted;
      });
      await new Promise((r) => setTimeout(r, 150));
      // Pre-fix handler: `subscription.update({ data: { status } })` from the event payload, no condition.
      const legacy = prisma.subscription.update({ where: { id: w.sub.id }, data: { status: SubscriptionStatus.ACTIVE } });
      await new Promise((r) => setTimeout(r, 150));
      releaseDeletion();
      await deletion;
      await legacy;
      expect(await row(w)).toMatchObject({ status: SubscriptionStatus.ACTIVE, endReason: SubscriptionEndReason.PAYMENT_FAILED }); // corrupted: alive with a terminal reason

      // The guarded statement under the same race: zero rows, state preserved.
      await prisma.subscription.update({ where: { id: w.sub.id }, data: { status: SubscriptionStatus.CANCELED } });
      const deletion2 = other.$transaction(async (tx) => {
        await tx.subscription.update({ where: { id: w.sub.id }, data: { endReason: SubscriptionEndReason.PAYMENT_FAILED } });
        await new Promise((r) => setTimeout(r, 300));
      });
      await new Promise((r) => setTimeout(r, 100));
      const guarded = await prisma.subscription.updateMany({ where: { id: w.sub.id, status: SubscriptionStatus.ACTIVE }, data: { status: SubscriptionStatus.ACTIVE } });
      await deletion2;
      expect(guarded.count).toBe(0);
      expect((await row(w)).status).toBe(SubscriptionStatus.CANCELED);
    } finally {
      await other.$disconnect();
    }
  });

  it('KILL SWITCH: BILLING_STALE_EVENT_GUARD=off restores the legacy upsert (documented, off by default)', async () => {
    const w = await buildWorld(prisma, { fullStatus: SubscriptionStatus.CANCELED });
    process.env['BILLING_STALE_EVENT_GUARD'] = 'off';
    stripeSays('canceled');
    await post(w.subscriptionEvent({ type: 'customer.subscription.updated', status: 'active' })).expect(200);
    expect((await row(w)).status).toBe(SubscriptionStatus.ACTIVE); // legacy behaviour, on purpose
    expect(stripe['retrieveSubscription']).not.toHaveBeenCalled();
  });
});
