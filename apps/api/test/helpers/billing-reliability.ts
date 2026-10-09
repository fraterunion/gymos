import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { BillingInterval, type PrismaClient, Role, SubscriptionSource, SubscriptionStatus } from '@prisma/client';
import Stripe from 'stripe';
import request from 'supertest';
import { createMembership, createStudio, createUserWithPassword } from './factories';

/**
 * Shared world + sanitized-payload builders for the billing reliability e2e suites. Every Stripe
 * event posted through these helpers is a REAL dahlia payload shape (test/fixtures/stripe-webhooks)
 * re-pointed at this world's rows; only ids, metadata and the fields a scenario changes are edited.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type StripeEvent = { id: string; type: string; created: number; data: { object: any; previous_attributes?: unknown } };

export const SEP_14 = new Date('2026-09-14T01:12:27.000Z');
export const OCT_14 = new Date('2026-10-14T01:12:27.000Z');
export const DAY_MS = 86_400_000;

export function fixture(name: string): StripeEvent {
  return JSON.parse(readFileSync(join(__dirname, '../fixtures/stripe-webhooks', `${name}.json`), 'utf8')) as StripeEvent;
}

/** Re-points fixture ids (exact quoted tokens) at this test's database rows. */
export function rebind(event: StripeEvent, tokens: Record<string, string>): StripeEvent {
  let json = JSON.stringify(event);
  for (const [from, to] of Object.entries(tokens)) json = json.split(`"${from}"`).join(`"${to}"`);
  return JSON.parse(json) as StripeEvent;
}

let eventSeq = 0;
export function nextEventId(prefix = 'evt_fx_rel'): string {
  eventSeq += 1;
  return `${prefix}_${eventSeq}`;
}

export function signedPost(app: INestApplication, webhookSecret: string, event: StripeEvent) {
  const payload = JSON.stringify(event);
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
  return request(app.getHttpServer())
    .post('/api/v1/stripe/webhook')
    .set('Stripe-Signature', header)
    .set('Content-Type', 'application/json')
    .send(payload);
}

export async function login(app: INestApplication, email: string, password: string): Promise<string> {
  const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password }).expect(201);
  return (res.body as { accessToken: string }).accessToken;
}

export type ReliabilityWorld = Awaited<ReturnType<typeof buildWorld>>;

/**
 * One studio with a monthly Full Access plan (CORE group) and a 45-day Booty Lab plan, a card
 * member with an ACTIVE Full Access subscription (Sep 14 → Oct 14, like the production incident),
 * and one user per staff role for authorization tests.
 */
export async function buildWorld(prisma: PrismaClient, opts: { fullStatus?: SubscriptionStatus; timezone?: string; suffix?: string } = {}) {
  // Stripe ids are unique columns: a second world in the same test needs its own suffix.
  const suffix = opts.suffix ?? '';
  const customerId = `cus_fx_member${suffix}`;
  const stripeSubscriptionId = `sub_fx_full${suffix}`;
  const studio = await createStudio(prisma, { timezone: opts.timezone ?? 'America/Mexico_City' });
  const full = await prisma.membershipPlan.create({
    data: {
      studioId: studio.id, name: 'Full Access', priceCents: 150000, currency: 'mxn', billingInterval: BillingInterval.MONTHLY,
      active: true, exclusiveGroup: 'CORE', stripePriceId: 'price_fx_full', stripeProductId: 'prod_fx_full',
    },
  });
  const booty = await prisma.membershipPlan.create({
    data: {
      studioId: studio.id, name: 'Booty Lab by Etzia', priceCents: 80000, currency: 'mxn', billingInterval: BillingInterval.MONTHLY,
      active: true, allClassesAccess: false, classCredits: 4, entitlementDays: 45, exclusiveGroup: null,
      stripePriceId: 'price_fx_booty_45d', stripeProductId: 'prod_fx_booty',
    },
  });
  const member = await createUserWithPassword(prisma);
  await prisma.user.update({ where: { id: member.id }, data: { stripeCustomerId: customerId, firstName: 'Fixture', lastName: 'Member' } });
  await createMembership(prisma, member.id, studio.id, Role.MEMBER);
  const owner = await createUserWithPassword(prisma);
  await createMembership(prisma, owner.id, studio.id, Role.OWNER);
  const admin = await createUserWithPassword(prisma);
  await createMembership(prisma, admin.id, studio.id, Role.ADMIN);
  const staff = await createUserWithPassword(prisma);
  await createMembership(prisma, staff.id, studio.id, Role.STAFF);
  const frontDesk = await createUserWithPassword(prisma);
  await createMembership(prisma, frontDesk.id, studio.id, Role.FRONT_DESK);
  const sub = await prisma.subscription.create({
    data: {
      studioId: studio.id, userId: member.id, membershipPlanId: full.id, status: opts.fullStatus ?? SubscriptionStatus.ACTIVE,
      source: SubscriptionSource.STRIPE, stripeSubscriptionId, exclusiveGroupKey: 'CORE',
      currentPeriodStart: SEP_14, currentPeriodEnd: OCT_14,
    },
  });
  const tokens = {
    // customer.subscription.* fixture (deleted-for-non-payment) ids
    sub_fx0026: stripeSubscriptionId, price_fx0027: 'price_fx_full', prod_fx0028: 'prod_fx_full', si_fx0029: `si_fx_full${suffix}`, cus_fx0030: customerId,
    // monthly invoice.paid fixture ids
    sub_fx0008: stripeSubscriptionId, price_fx0010: 'price_fx_full', prod_fx0011: 'prod_fx_full', si_fx0009: `si_fx_full${suffix}`, cus_fx0014: customerId,
    // booty fixtures
    cus_fx_booty_member: customerId, fx_user_booty_member: member.id, fx_plan_booty: booty.id,
    fx_studio_ares: studio.id,
  };
  const fullMetadata = { userId: member.id, studioId: studio.id, planId: full.id };

  /** A real `customer.subscription.deleted` payload (reason payment_failed) re-pointed at Full Access, optionally mutated. */
  function subscriptionEvent(overrides: {
    type?: 'customer.subscription.updated' | 'customer.subscription.deleted' | 'customer.subscription.created';
    status?: string;
    cancelAtPeriodEnd?: boolean;
    cancellationReason?: string | null;
    created?: number;
    id?: string;
    periodStart?: number;
    periodEnd?: number;
    previousAttributes?: unknown;
  } = {}): StripeEvent {
    const event = rebind(fixture('dahlia-subscription-deleted-payment-failed'), tokens);
    const obj = event.data.object;
    obj.metadata = fullMetadata;
    const type = overrides.type ?? 'customer.subscription.deleted';
    event.type = type;
    event.id = overrides.id ?? nextEventId();
    if (overrides.created) event.created = overrides.created;
    const status = overrides.status ?? (type === 'customer.subscription.deleted' ? 'canceled' : 'active');
    obj.status = status;
    const terminal = status === 'canceled' || status === 'incomplete_expired';
    obj.canceled_at = terminal ? obj.canceled_at : null;
    obj.ended_at = terminal ? obj.ended_at : null;
    obj.cancel_at_period_end = overrides.cancelAtPeriodEnd ?? false;
    obj.cancellation_details = { reason: overrides.cancellationReason === undefined ? (terminal ? 'payment_failed' : null) : overrides.cancellationReason, comment: null, feedback: null, feedback_option: null };
    if (overrides.periodStart) obj.items.data[0].current_period_start = overrides.periodStart;
    if (overrides.periodEnd) obj.items.data[0].current_period_end = overrides.periodEnd;
    event.data.previous_attributes = overrides.previousAttributes ?? null;
    return event;
  }

  /** The real monthly `invoice.paid` renewal payload re-pointed at Full Access (MXN 600, Oct 2 → Nov 2 line). */
  function monthlyPaidInvoice(overrides: { id?: string; invoiceId?: string; billingReason?: string; paidAt?: number } = {}): StripeEvent {
    const event = rebind(fixture('dahlia-invoice-paid-monthly-renewal'), tokens);
    const obj = event.data.object;
    obj.parent.subscription_details.metadata = fullMetadata;
    event.id = overrides.id ?? nextEventId('evt_fx_paid');
    if (overrides.invoiceId) obj.id = overrides.invoiceId;
    if (overrides.billingReason) obj.billing_reason = overrides.billingReason;
    if (overrides.paidAt) obj.status_transitions.paid_at = overrides.paidAt;
    return event;
  }

  /** The real Booty Lab 45-day renewal `invoice.paid` (MXN 800, Oct 2 → Nov 16). */
  function bootyPaidInvoice(overrides: { id?: string; paidAt?: number } = {}): StripeEvent {
    const event = rebind(fixture('dahlia-invoice-paid-booty-renewal'), tokens);
    event.id = overrides.id ?? nextEventId('evt_fx_booty_paid');
    if (overrides.paidAt) event.data.object.status_transitions.paid_at = overrides.paidAt;
    return event;
  }

  /** Unix seconds "now": a payment made after whatever the test just did (a late payment). */
  function nowUnix(): number {
    return Math.floor(Date.now() / 1000) + 1;
  }

  /** The real late `invoice.payment_failed` (delivered after the deletion) re-pointed at Full Access. */
  function lateFailedInvoice(overrides: { id?: string } = {}): StripeEvent {
    const event = rebind(fixture('dahlia-invoice-payment-failed-after-delete'), tokens);
    event.data.object.parent.subscription_details.subscription = stripeSubscriptionId;
    event.data.object.parent.subscription_details.metadata = fullMetadata;
    event.id = overrides.id ?? nextEventId('evt_fx_failed');
    return event;
  }

  /**
   * Synthetic (no production capture exists) but field-faithful `charge.refunded` /
   * `charge.dispute.created`. Like real basil/dahlia charges they carry NO `invoice` field: the
   * handler must match through the PaymentIntent (optionally via the InvoicePayment lookup).
   */
  function chargeRefunded(input: { chargeId: string; amount: number; amountRefunded: number; paymentIntent: string | null }): StripeEvent {
    return {
      id: nextEventId('evt_fx_refund'), type: 'charge.refunded', created: 1791400000,
      data: { object: { id: input.chargeId, object: 'charge', amount: input.amount, amount_refunded: input.amountRefunded, refunded: input.amountRefunded >= input.amount, currency: 'mxn', customer: customerId, payment_intent: input.paymentIntent, livemode: true } },
    };
  }
  function chargeDisputed(input: { disputeId: string; chargeId: string; paymentIntent: string; amount: number }): StripeEvent {
    return {
      id: nextEventId('evt_fx_dispute'), type: 'charge.dispute.created', created: 1791400100,
      data: { object: { id: input.disputeId, object: 'dispute', amount: input.amount, currency: 'mxn', reason: 'fraudulent', status: 'needs_response', charge: input.chargeId, payment_intent: input.paymentIntent, livemode: true } },
    };
  }

  return { studio, full, booty, member, owner, admin, staff, frontDesk, sub, customerId, stripeSubscriptionId, tokens, fullMetadata, subscriptionEvent, monthlyPaidInvoice, bootyPaidInvoice, lateFailedInvoice, chargeRefunded, chargeDisputed, nowUnix };
}

/** Count of calls to a Stripe mutation mock; the e2e mock leaves un-stubbed mutations undefined. */
export function stripeMutationCalls(stripe: Record<string, jest.Mock | undefined>): number {
  return ['updateSubscription', 'cancelSubscription', 'scheduleSubscriptionPriceChangeAtPeriodEnd', 'createRecurringPrice', 'deactivatePrice']
    .reduce((n, m) => n + (stripe[m]?.mock.calls.length ?? 0), 0);
}

/** A Stripe.Subscription-shaped object for `listSubscriptionsForCustomer` mocks (basil item periods). */
export function stripeSubscriptionLike(input: {
  id: string; customer: string; status: string; studioId: string; userId: string; planId: string; priceId?: string;
  cancelAtPeriodEnd?: boolean; canceledAt?: number | null; cancellationReason?: string | null; periodStart?: number; periodEnd?: number; latestInvoice?: string | null;
}) {
  return {
    id: input.id, object: 'subscription', customer: input.customer, status: input.status,
    cancel_at_period_end: input.cancelAtPeriodEnd ?? false, canceled_at: input.canceledAt ?? null,
    cancellation_details: { reason: input.cancellationReason ?? null, comment: null, feedback: null },
    metadata: { studioId: input.studioId, userId: input.userId, planId: input.planId },
    latest_invoice: input.latestInvoice ?? null,
    items: { data: [{ id: `si_${input.id}`, price: { id: input.priceId ?? 'price_fx_full' }, current_period_start: input.periodStart ?? Math.floor(SEP_14.getTime() / 1000), current_period_end: input.periodEnd ?? Math.floor(OCT_14.getTime() / 1000) }] },
  };
}
