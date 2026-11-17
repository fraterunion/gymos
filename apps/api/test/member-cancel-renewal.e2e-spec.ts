import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BillingInterval, Role, SubscriptionSource, SubscriptionStatus } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { StripeService } from '../src/stripe/stripe.service';
import { STRIPE_RENEWAL_DISABLED } from '../src/billing/stripe-renewal-audit.constants';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import { createMembership, createStudio, createUserWithPassword } from './helpers/factories';
import { buildWorld, login, OCT_14, signedPost, type ReliabilityWorld } from './helpers/billing-reliability';

/**
 * Authenticated member cancellation. Stripe HTTP is mocked. Postgres, auth,
 * studio scope, advisory locks and webhooks are real. Nothing here calls live Stripe.
 */
describe('Member cancel renewal (e2e)', () => {
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
  });

  function arm(opts: {
    status?: string;
    cancelAtPeriodEnd?: boolean;
    customer?: string;
    invoices?: unknown[];
    /** timeout-applied flips the flag then throws. timeout-open throws and leaves it false. */
    update?: 'ok' | 'timeout-applied' | 'timeout-open';
    subscriptionId?: string;
  } = {}) {
    const subscriptionId = opts.subscriptionId ?? 'sub_fx_full';
    let applied = opts.cancelAtPeriodEnd ?? false;
    stripe['retrieveSubscription'].mockImplementation(async (id: string) => ({
      id,
      object: 'subscription',
      status: opts.status ?? 'active',
      customer: opts.customer ?? 'cus_fx_member',
      cancel_at_period_end: id === subscriptionId ? applied : false,
      items: { data: [{ current_period_end: Math.floor(OCT_14.getTime() / 1000) }] },
    }));
    stripe['listOpenInvoicesForSubscription'].mockResolvedValue(opts.invoices ?? []);
    stripe['updateSubscription'].mockImplementation(async (id: string) => {
      if (opts.update === 'timeout-applied') {
        applied = true;
        throw Object.assign(new Error('stripe timeout'), { code: 'ETIMEDOUT' });
      }
      if (opts.update === 'timeout-open') {
        throw Object.assign(new Error('stripe timeout'), { code: 'ETIMEDOUT' });
      }
      if (id === subscriptionId) applied = true;
      return { id, object: 'subscription', status: opts.status ?? 'active', cancel_at_period_end: true };
    });
  }

  async function tokenFor(world: ReliabilityWorld): Promise<string> {
    return login(app, world.member.email, world.member.password);
  }

  function cancel(token: string, studioId: string, subscriptionId: string) {
    return request(app.getHttpServer())
      .post(`/api/v1/studios/${studioId}/members/me/subscriptions/${subscriptionId}/cancel-renewal`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
  }

  function preview(token: string, studioId: string, subscriptionId: string) {
    return request(app.getHttpServer())
      .get(`/api/v1/studios/${studioId}/members/me/subscriptions/${subscriptionId}/cancel-renewal-preview`)
      .set('Authorization', `Bearer ${token}`);
  }

  async function audits(subscriptionId: string) {
    return prisma.auditLog.findMany({
      where: { entityId: subscriptionId, action: STRIPE_RENEWAL_DISABLED },
    });
  }

  it('cancels an ACTIVE Stripe subscription at period end and keeps the locked price', async () => {
    const world = await buildWorld(prisma);
    await prisma.subscription.update({ where: { id: world.sub.id }, data: { priceCents: 100000 } });
    arm({ status: 'active' });
    const token = await tokenFor(world);

    const me = await request(app.getHttpServer())
      .get(`/api/v1/studios/${world.studio.id}/members/me`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const card = (me.body.memberships as Array<{ subscriptionId: string; plan: { priceCents: number; catalogPriceCents: number } }>)
      .find((row) => row.subscriptionId === world.sub.id);
    expect(card?.plan.priceCents).toBe(100000);
    expect(card?.plan.catalogPriceCents).toBe(150000);

    const res = await cancel(token, world.studio.id, world.sub.id).expect(200);
    expect(res.body).toMatchObject({
      outcome: 'scheduled',
      verifiedAgainstStripe: true,
      cancelAtPeriodEnd: true,
      status: 'ACTIVE',
      liveStatus: 'active',
    });
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: world.sub.id } });
    expect(row.cancelAtPeriodEnd).toBe(true);
    expect(row.status).toBe(SubscriptionStatus.ACTIVE);
    expect(row.membershipPlanId).toBe(world.full.id);
    expect(row.priceCents).toBe(100000);
    const written = await audits(world.sub.id);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ actorUserId: world.member.id, targetUserId: world.member.id });
    expect(written[0]?.metadata).toMatchObject({
      sourceSurface: 'MEMBER_APP',
      liveStripeStatus: 'active',
      newCancelAtPeriodEnd: true,
    });
  });

  it('cancels TRIALING and PAST_DUE without restoring access or changing status', async () => {
    for (const [local, stripeStatus] of [
      [SubscriptionStatus.TRIALING, 'trialing'],
      [SubscriptionStatus.PAST_DUE, 'past_due'],
      [SubscriptionStatus.PAST_DUE, 'unpaid'],
    ] as const) {
      await truncateAll(prisma);
      const world = await buildWorld(prisma, { fullStatus: local, suffix: stripeStatus });
      arm({
        status: stripeStatus,
        subscriptionId: world.stripeSubscriptionId,
        customer: world.customerId,
      });
      const token = await tokenFor(world);
      const res = await cancel(token, world.studio.id, world.sub.id).expect(200);
      expect(res.body.verifiedAgainstStripe).toBe(true);
      expect(res.body.status).toBe(local);
      const row = await prisma.subscription.findUniqueOrThrow({ where: { id: world.sub.id } });
      expect(row.status).toBe(local);
      expect(row.cancelAtPeriodEnd).toBe(true);
    }
  });

  it('shows an open invoice before confirming and does not void it', async () => {
    const world = await buildWorld(prisma, { fullStatus: SubscriptionStatus.PAST_DUE });
    const invoice = {
      id: 'in_open_1',
      amount_remaining: 45000,
      amount_due: 45000,
      currency: 'mxn',
      parent: { subscription_details: { subscription: world.sub.stripeSubscriptionId } },
    };
    arm({ status: 'past_due', invoices: [invoice] });
    const token = await tokenFor(world);

    const seen = await preview(token, world.studio.id, world.sub.id).expect(200);
    expect(seen.body.eligible).toBe(true);
    expect(seen.body.openInvoices).toEqual([{ id: 'in_open_1', amountDueCents: 45000, currency: 'mxn' }]);

    const res = await cancel(token, world.studio.id, world.sub.id).expect(200);
    expect(res.body.openInvoices).toEqual([{ id: 'in_open_1', amountDueCents: 45000, currency: 'mxn' }]);
    expect(res.body.status).toBe('PAST_DUE');
    expect(stripe['updateSubscription']).toHaveBeenCalledWith(
      world.sub.stripeSubscriptionId,
      { cancel_at_period_end: true },
      expect.any(Object),
    );
    const updateArgs = stripe['updateSubscription'].mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(updateArgs)).toEqual(['cancel_at_period_end']);
  });

  it('treats an already-scheduled Stripe subscription as idempotent success', async () => {
    const world = await buildWorld(prisma);
    arm({ cancelAtPeriodEnd: true });
    const token = await tokenFor(world);

    const first = await cancel(token, world.studio.id, world.sub.id).expect(200);
    expect(first.body.outcome).toBe('already_scheduled');
    expect(stripe['updateSubscription']).not.toHaveBeenCalled();

    const second = await cancel(token, world.studio.id, world.sub.id).expect(200);
    expect(second.body.outcome).toBe('already_scheduled');
    expect(second.body.verifiedAgainstStripe).toBe(true);
    expect(await audits(world.sub.id)).toHaveLength(0);
  });

  it('does not claim success on an unverified Stripe timeout, then accepts a verified retry', async () => {
    const world = await buildWorld(prisma);
    arm({ update: 'timeout-open' });
    const token = await tokenFor(world);

    const failed = await cancel(token, world.studio.id, world.sub.id).expect(400);
    expect(failed.body.message).toMatch(/No pudimos confirmar/);
    const before = await prisma.subscription.findUniqueOrThrow({ where: { id: world.sub.id } });
    expect(before.cancelAtPeriodEnd).toBe(false);

    arm({ update: 'timeout-applied' });
    const recovered = await cancel(token, world.studio.id, world.sub.id).expect(200);
    expect(recovered.body).toMatchObject({ outcome: 'scheduled', verifiedAgainstStripe: true, cancelAtPeriodEnd: true });
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: world.sub.id } });
    expect(after.cancelAtPeriodEnd).toBe(true);
  });

  it('reconciles when Stripe succeeded and the local write failed', async () => {
    const world = await buildWorld(prisma);
    arm();
    const token = await tokenFor(world);
    const spy = jest.spyOn(prisma, '$transaction').mockRejectedValueOnce(new Error('db down'));

    const failed = await cancel(token, world.studio.id, world.sub.id).expect(503);
    expect(failed.body.message).toMatch(/Stripe ya detuvo la renovación/);
    spy.mockRestore();
    const unsaved = await prisma.subscription.findUniqueOrThrow({ where: { id: world.sub.id } });
    expect(unsaved.cancelAtPeriodEnd).toBe(false);
    expect(await audits(world.sub.id)).toHaveLength(1);

    arm({ cancelAtPeriodEnd: true });
    const healed = await cancel(token, world.studio.id, world.sub.id).expect(200);
    expect(healed.body.outcome).toBe('already_scheduled');
    const saved = await prisma.subscription.findUniqueOrThrow({ where: { id: world.sub.id } });
    expect(saved.cancelAtPeriodEnd).toBe(true);
    expect(await audits(world.sub.id)).toHaveLength(1);
  });

  it('serializes concurrent requests into one audit and one saved flag', async () => {
    const world = await buildWorld(prisma);
    arm();
    const token = await tokenFor(world);

    const [a, b] = await Promise.all([
      cancel(token, world.studio.id, world.sub.id),
      cancel(token, world.studio.id, world.sub.id),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 200]);
    expect(a.body.verifiedAgainstStripe).toBe(true);
    expect(b.body.verifiedAgainstStripe).toBe(true);
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: world.sub.id } });
    expect(row.cancelAtPeriodEnd).toBe(true);
    expect(row.status).toBe(SubscriptionStatus.ACTIVE);
    expect(await audits(world.sub.id)).toHaveLength(1);
  });

  it('rejects another member, another studio, and an anonymous caller', async () => {
    const world = await buildWorld(prisma);
    arm();
    const token = await tokenFor(world);
    const stranger = await createUserWithPassword(prisma);
    await createMembership(prisma, stranger.id, world.studio.id, Role.MEMBER);
    const strangerToken = await login(app, stranger.email, stranger.password);
    const otherStudio = await createStudio(prisma);

    await cancel(strangerToken, world.studio.id, world.sub.id).expect(404);
    await cancel(token, otherStudio.id, world.sub.id).expect(403);
    await request(app.getHttpServer())
      .post(`/api/v1/studios/${world.studio.id}/members/me/subscriptions/${world.sub.id}/cancel-renewal`)
      .send({})
      .expect(401);
    expect(stripe['updateSubscription']).not.toHaveBeenCalled();
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: world.sub.id } });
    expect(row.cancelAtPeriodEnd).toBe(false);
  });

  it('cancels only the selected subscription when the member has two', async () => {
    const world = await buildWorld(prisma);
    const otherPlan = await prisma.membershipPlan.create({
      data: {
        studioId: world.studio.id,
        name: 'Booty Lab',
        priceCents: 80000,
        currency: 'mxn',
        billingInterval: BillingInterval.MONTHLY,
        active: true,
        stripePriceId: 'price_fx_second',
        stripeProductId: 'prod_fx_second',
      },
    });
    const other = await prisma.subscription.create({
      data: {
        studioId: world.studio.id,
        userId: world.member.id,
        membershipPlanId: otherPlan.id,
        status: SubscriptionStatus.ACTIVE,
        source: SubscriptionSource.STRIPE,
        stripeSubscriptionId: 'sub_fx_second',
        currentPeriodStart: world.sub.currentPeriodStart,
        currentPeriodEnd: world.sub.currentPeriodEnd,
      },
    });
    arm({ subscriptionId: world.sub.stripeSubscriptionId ?? 'sub_fx_full' });
    const token = await tokenFor(world);

    await cancel(token, world.studio.id, world.sub.id).expect(200);
    const kept = await prisma.subscription.findUniqueOrThrow({ where: { id: other.id } });
    const canceled = await prisma.subscription.findUniqueOrThrow({ where: { id: world.sub.id } });
    expect(canceled.cancelAtPeriodEnd).toBe(true);
    expect(kept.cancelAtPeriodEnd).toBe(false);
    expect(kept.status).toBe(SubscriptionStatus.ACTIVE);
    expect(stripe['updateSubscription'].mock.calls.map((call) => call[0])).toEqual([world.sub.stripeSubscriptionId]);
  });

  it('refuses CASH and MANUAL memberships', async () => {
    for (const source of [SubscriptionSource.CASH, SubscriptionSource.MANUAL]) {
      await truncateAll(prisma);
      const world = await buildWorld(prisma, { suffix: source });
      await prisma.subscription.update({
        where: { id: world.sub.id },
        data: { source, stripeSubscriptionId: null },
      });
      arm();
      const token = await tokenFor(world);
      const res = await cancel(token, world.studio.id, world.sub.id).expect(400);
      expect(res.body.message).toMatch(/tarjeta/);
      expect(stripe['updateSubscription']).not.toHaveBeenCalled();
    }
  });

  it('explains a live Stripe status that cannot be scheduled', async () => {
    const world = await buildWorld(prisma);
    arm({ status: 'paused' });
    const token = await tokenFor(world);
    const seen = await preview(token, world.studio.id, world.sub.id).expect(200);
    expect(seen.body.eligible).toBe(false);
    expect(seen.body.explanation).toMatch(/pausa/);
    const res = await cancel(token, world.studio.id, world.sub.id).expect(400);
    expect(res.body.message).toMatch(/pausa/);
    expect(res.body.message).toMatch(/factura/i);
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: world.sub.id } });
    expect(row.cancelAtPeriodEnd).toBe(false);
    expect(stripe['updateSubscription']).not.toHaveBeenCalled();
  });

  it('rejects a Stripe customer that is not linked to the member', async () => {
    const world = await buildWorld(prisma);
    arm({ customer: 'cus_someone_else' });
    const token = await tokenFor(world);
    await cancel(token, world.studio.id, world.sub.id).expect(403);
    expect(stripe['updateSubscription']).not.toHaveBeenCalled();
  });

  it('stays consistent when the webhook arrives before or after the local write', async () => {
    const before = await buildWorld(prisma, { suffix: '_before' });
    const beforeToken = await tokenFor(before);
    arm({
      cancelAtPeriodEnd: true,
      subscriptionId: before.stripeSubscriptionId,
      customer: before.customerId,
    });
    await signedPost(
      app,
      webhookSecret,
      before.subscriptionEvent({
        type: 'customer.subscription.updated',
        status: 'active',
        cancelAtPeriodEnd: true,
        cancellationReason: 'cancellation_requested',
      }),
    ).expect(200);
    const replay = await cancel(beforeToken, before.studio.id, before.sub.id).expect(200);
    expect(replay.body.outcome).toBe('already_scheduled');
    expect(stripe['updateSubscription']).not.toHaveBeenCalled();

    const after = await buildWorld(prisma, { suffix: '_after' });
    arm({ status: 'active', subscriptionId: after.stripeSubscriptionId, customer: after.customerId });
    const afterToken = await tokenFor(after);
    await cancel(afterToken, after.studio.id, after.sub.id).expect(200);
    await signedPost(
      app,
      webhookSecret,
      after.subscriptionEvent({
        type: 'customer.subscription.updated',
        status: 'active',
        cancelAtPeriodEnd: true,
        cancellationReason: 'cancellation_requested',
      }),
    ).expect(200);
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: after.sub.id } });
    expect(row.cancelAtPeriodEnd).toBe(true);
    expect(row.status).toBe(SubscriptionStatus.ACTIVE);
    expect(row.membershipPlanId).toBe(after.full.id);
  });

  it('cancels when the open-invoice lookup is unavailable and says the balance was not verified', async () => {
    const world = await buildWorld(prisma);
    arm();
    stripe['listOpenInvoicesForSubscription'].mockRejectedValue(new Error('invoice timeout'));
    const token = await tokenFor(world);

    const seen = await preview(token, world.studio.id, world.sub.id).expect(200);
    expect(seen.body.eligible).toBe(true);
    expect(seen.body.invoicesUnverified).toBe(true);
    expect(seen.body.openInvoices).toBeNull();
    expect(seen.body.currentPeriodEnd).toBe(OCT_14.toISOString());

    const res = await cancel(token, world.studio.id, world.sub.id).expect(200);
    expect(res.body.verifiedAgainstStripe).toBe(true);
    expect(res.body.invoicesUnverified).toBe(true);
    expect(res.body.openInvoices).toBeNull();
    expect(stripe['updateSubscription']).toHaveBeenCalledWith(
      world.stripeSubscriptionId,
      { cancel_at_period_end: true },
      expect.any(Object),
    );
  });

  it('replaces a stale local cancellation with the live Stripe period and still allows stopping renewal', async () => {
    const world = await buildWorld(prisma);
    await prisma.subscription.update({
      where: { id: world.sub.id },
      data: { cancelAtPeriodEnd: true, currentPeriodEnd: new Date('2026-01-01T00:00:00.000Z') },
    });
    arm({ cancelAtPeriodEnd: false });
    const token = await tokenFor(world);

    const seen = await preview(token, world.studio.id, world.sub.id).expect(200);
    expect(seen.body).toMatchObject({
      eligible: true,
      alreadyScheduled: false,
      verifiedAgainstStripe: true,
      cancelAtPeriodEnd: false,
      staleLocalCancel: true,
      currentPeriodEnd: OCT_14.toISOString(),
    });
    expect(seen.body.explanation).toMatch(/renovación sigue activa/);
    const cleared = await prisma.subscription.findUniqueOrThrow({ where: { id: world.sub.id } });
    expect(cleared.cancelAtPeriodEnd).toBe(false);
    expect(cleared.currentPeriodEnd?.toISOString()).toBe(OCT_14.toISOString());
    expect(cleared.status).toBe(SubscriptionStatus.ACTIVE);
    expect(stripe['updateSubscription']).not.toHaveBeenCalled();

    const res = await cancel(token, world.studio.id, world.sub.id).expect(200);
    expect(res.body).toMatchObject({
      outcome: 'scheduled',
      verifiedAgainstStripe: true,
      cancelAtPeriodEnd: true,
      currentPeriodEnd: OCT_14.toISOString(),
    });
    const saved = await prisma.subscription.findUniqueOrThrow({ where: { id: world.sub.id } });
    expect(saved.cancelAtPeriodEnd).toBe(true);
    expect(saved.currentPeriodEnd?.toISOString()).toBe(OCT_14.toISOString());
    expect(saved.priceCents).toBe(cleared.priceCents);
    expect(saved.membershipPlanId).toBe(world.full.id);
  });
});
