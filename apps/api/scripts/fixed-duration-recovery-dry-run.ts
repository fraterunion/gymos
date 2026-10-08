/**
 * READ-ONLY recovery dry-run for paid fixed-duration invoices that never produced their
 * entitlement cycle (Booty Lab renewal incident, 2026-10-02).
 *
 * Usage (production, read-only):
 *   railway run --service api npx tsx scripts/fixed-duration-recovery-dry-run.ts [in_... ...] [--json out.json]
 * Without invoice ids it checks the two invoices of the incident. Run it again immediately before
 * each recovery step (event re-delivery) and after it: a recovered invoice reports ALREADY_RECOVERED.
 *
 * Guarantees — this script cannot change anything:
 *  - every database read runs inside ONE transaction switched to `SET TRANSACTION READ ONLY`
 *    (verified with `SHOW transaction_read_only`), so Postgres rejects any write;
 *  - Stripe is reached only through `readOnlyStripe()`, which exposes GET endpoints only;
 *  - it never instantiates Nest services or webhook handlers; it calls only the PURE decision
 *    functions the fixed handler uses (classifyFixedDurationInvoice, planPaidCycleInsertion,
 *    findPaidWithoutEntitlement), so its verdict is the handler's verdict.
 * It prints Stripe/local ids only — no names, emails or payment instrument data.
 */
import { PrismaClient, SubscriptionEndReason, SubscriptionSource, SubscriptionStatus, type Prisma } from '@prisma/client';
import Stripe from 'stripe';
import { writeFileSync } from 'node:fs';
import { classifyFixedDurationInvoice, type FixedDurationDecision } from '../src/billing/fixed-duration-invoice';
import { buildPaidFixedEntitlementCycle, planPaidCycleInsertion, type CycleInsertionPlan } from '../src/billing/fixed-entitlement-cycle';
import { loadPaidWithoutEntitlement, type PaidWithoutEntitlement } from '../src/billing/paid-without-entitlement';
import { readInvoiceSubscriptionId, readStripeInvoiceSubscriptionId } from '../src/billing/stripe-invoice.utils';
import { RENEWABLE_SUBSCRIPTION_STATUSES } from '../src/billing/subscription-lifecycle.constants';
import type { WebhookInvoicePayload } from '../src/billing/stripe-webhook-payloads';

/** The incident's invoices and the cycles the audit expects them to produce. */
const INCIDENT_EXPECTATIONS: Record<string, { startsAt: string; endsAt: string; credits: number }> = {
  in_1UM9kDGuUoCXNOREOOyKkEXv: { startsAt: '2026-10-02T16:54:40.000Z', endsAt: '2026-11-16T16:54:40.000Z', credits: 4 },
  in_1UMADXGuUoCXNORECKKIw6Gd: { startsAt: '2026-10-02T17:24:56.000Z', endsAt: '2026-11-16T17:24:56.000Z', credits: 4 },
};
const DAY_MS = 86_400_000;

function readOnlyStripe(secretKey: string) {
  const client = new Stripe(secretKey, { apiVersion: '2025-08-27.basil' });
  return {
    retrieveInvoice: (id: string) => client.invoices.retrieve(id),
    listInvoicePayments: (invoice: string) => client.invoicePayments.list({ invoice, limit: 10 }),
    retrievePaymentIntent: (id: string) => client.paymentIntents.retrieve(id, { expand: ['latest_charge'] }),
    listCreditNotes: (invoice: string) => client.creditNotes.list({ invoice, limit: 10 }),
    retrieveSubscription: (id: string) => client.subscriptions.retrieve(id),
    retrievePrice: (id: string) => client.prices.retrieve(id),
  };
}

/** `blocking: false` checks are reported but never prevent recovery. */
type Check = { name: string; ok: boolean; detail: string; blocking?: boolean };

const SUPERSEDED_REASONS: SubscriptionEndReason[] = [
  SubscriptionEndReason.SUPERSEDED_PAYMENT_METHOD,
  SubscriptionEndReason.SUPERSEDED_RENEWAL,
  SubscriptionEndReason.SUPERSEDED_PLAN_CHANGE,
];

function summarizeDecision(decision: FixedDurationDecision) {
  return decision.kind === 'grant'
    ? { kind: decision.kind, startsAt: decision.periodStart.toISOString(), endsAt: decision.periodEnd.toISOString(), creditLimit: decision.creditLimit, priceMatch: decision.priceMatch, lines: decision.lines }
    : decision.kind === 'skip'
      ? { kind: decision.kind, reason: decision.reason, detail: decision.detail, lines: decision.lines }
      : { kind: decision.kind, code: decision.code, detail: decision.detail, lines: decision.lines };
}

function summarizePlan(plan: CycleInsertionPlan | null) {
  if (!plan) return null;
  if (plan.action === 'insert') {
    return { action: plan.action, mode: plan.mode, startsAt: plan.cycle.startsAt.toISOString(), endsAt: plan.cycle.endsAt.toISOString(), creditLimit: plan.cycle.creditLimit };
  }
  if (plan.action === 'reject') return { action: plan.action, code: plan.code, conflictingCycleId: plan.conflicting.id };
  return { action: plan.action, existingCycleId: plan.existing.id };
}

type SubscriptionWithPlan = Prisma.SubscriptionGetPayload<{ include: { membershipPlan: true } }>;
type CycleRow = { id: string; subscriptionId: string; startsAt: Date; endsAt: Date; stripeInvoiceId: string | null; creditLimit: number | null };

async function main() {
  const args = process.argv.slice(2);
  const jsonIdx = args.indexOf('--json');
  const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null;
  const invoiceIds = args.filter((a, i) => a.startsWith('in_') && args[i - 1] !== '--json');
  const targets = invoiceIds.length > 0 ? invoiceIds : Object.keys(INCIDENT_EXPECTATIONS);

  const secretKey = process.env['STRIPE_SECRET_KEY'];
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY is required (read-only use)');
  const stripe = readOnlyStripe(secretKey);
  const prisma = new PrismaClient();
  const now = new Date();

  try {
    // ── Stripe facts per target (GET only) ──────────────────────────────────
    const stripeFacts: Record<string, Record<string, unknown>> = {};
    for (const invoiceId of targets) {
      const invoice = await stripe.retrieveInvoice(invoiceId);
      const invoicePayments = await stripe.listInvoicePayments(invoiceId);
      const paymentIntentIds = invoicePayments.data
        .filter((p) => p.payment.type === 'payment_intent' && p.status === 'paid')
        .map((p) => (typeof p.payment.payment_intent === 'string' ? p.payment.payment_intent : p.payment.payment_intent?.id))
        .filter((id): id is string => !!id);
      const intents = [];
      for (const id of paymentIntentIds) {
        const pi = await stripe.retrievePaymentIntent(id);
        const charge = pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
        intents.push({
          id: pi.id, status: pi.status, amount: pi.amount, currency: pi.currency,
          chargeId: charge?.id ?? null, refunded: charge?.refunded ?? null, amountRefunded: charge?.amount_refunded ?? null, disputed: charge?.disputed ?? null,
        });
      }
      const creditNotes = await stripe.listCreditNotes(invoiceId);
      const subscriptionId = readStripeInvoiceSubscriptionId(invoice);
      const subscription = subscriptionId ? await stripe.retrieveSubscription(subscriptionId) : null;
      const item = subscription?.items.data[0];
      stripeFacts[invoiceId] = {
        invoice, status: invoice.status, billingReason: invoice.billing_reason, amountPaid: invoice.amount_paid,
        amountRemaining: invoice.amount_remaining, currency: invoice.currency,
        customerId: typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id ?? null,
        checkoutPlanId: invoice.parent?.subscription_details?.metadata?.['planId'] ?? null,
        paidAt: invoice.status_transitions?.paid_at ? new Date(invoice.status_transitions.paid_at * 1000).toISOString() : null,
        subscriptionId, intents, creditNotes: creditNotes.data.map((n) => ({ id: n.id, amount: n.total, status: n.status })),
        subscription: subscription
          ? {
              id: subscription.id, status: subscription.status, cancelAtPeriodEnd: subscription.cancel_at_period_end,
              itemPriceId: item?.price.id ?? null,
              currentPeriodStart: item ? new Date(item.current_period_start * 1000).toISOString() : null,
              currentPeriodEnd: item ? new Date(item.current_period_end * 1000).toISOString() : null,
            }
          : null,
      };
    }

    // ── Database (one READ ONLY transaction) ────────────────────────────────
    const db = await prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        const [{ transaction_read_only: readOnly }] = await tx.$queryRaw<Array<{ transaction_read_only: string }>>`SHOW transaction_read_only`;
        if (readOnly !== 'on') throw new Error('refusing to continue: transaction is not read-only');

        const perInvoice: Record<string, Record<string, unknown>> = {};
        for (const invoiceId of targets) {
          const facts = stripeFacts[invoiceId];
          const stripeSubscriptionId = facts['subscriptionId'] as string | null;
          const subscription = stripeSubscriptionId
            ? await tx.subscription.findUnique({ where: { stripeSubscriptionId }, include: { membershipPlan: true } })
            : null;
          const cycles: CycleRow[] = subscription
            ? await tx.membershipEntitlementCycle.findMany({
                where: { subscriptionId: subscription.id },
                select: { id: true, subscriptionId: true, startsAt: true, endsAt: true, stripeInvoiceId: true, creditLimit: true },
                orderBy: { startsAt: 'asc' },
              })
            : [];
          const cycleForInvoice = await tx.membershipEntitlementCycle.findUnique({
            where: { stripeInvoiceId: invoiceId },
            select: { id: true, subscriptionId: true, startsAt: true, endsAt: true, stripeInvoiceId: true },
          });
          const payments = await tx.payment.findMany({
            where: { stripeInvoiceId: invoiceId },
            select: { id: true, status: true, amountCents: true, currency: true, subscriptionId: true, stripePaymentIntentId: true, paidAt: true },
          });
          const storedEvents = await tx.$queryRaw<Array<{ stripe_event_id: string; processed: boolean; attempt_count: number; last_error: string | null; resolved_at: Date | null; payload: unknown }>>`
            SELECT stripe_event_id, processed, attempt_count, last_error, resolved_at, payload
            FROM stripe_webhook_events
            WHERE event_type = 'invoice.paid' AND payload->'data'->'object'->>'id' = ${invoiceId}
            ORDER BY created_at ASC`;
          // What the webhook handler's context resolution needs on re-delivery.
          const customerId = facts['customerId'] as string | null;
          const customerUser = customerId
            ? await tx.user.findFirst({ where: { stripeCustomerId: customerId, deletedAt: null }, select: { id: true } })
            : null;
          const studioMembership = subscription
            ? await tx.studioMembership.findFirst({ where: { studioId: subscription.studioId, userId: subscription.userId, deletedAt: null }, select: { id: true } })
            : null;
          // Sibling rows of the same membership family (same plan or same exclusive group).
          const siblings = subscription
            ? await tx.subscription.findMany({
                where: {
                  studioId: subscription.studioId,
                  userId: subscription.userId,
                  id: { not: subscription.id },
                  OR: [
                    { membershipPlanId: subscription.membershipPlanId },
                    ...(subscription.membershipPlan.exclusiveGroup ? [{ exclusiveGroupKey: subscription.membershipPlan.exclusiveGroup }] : []),
                  ],
                },
                select: { id: true, status: true, source: true, entitlementEndsAt: true, currentPeriodEnd: true, membershipPlanId: true },
              })
            : [];
          const siblingCycles: CycleRow[] = siblings.length
            ? await tx.membershipEntitlementCycle.findMany({
                where: { subscriptionId: { in: siblings.map((s) => s.id) } },
                select: { id: true, subscriptionId: true, startsAt: true, endsAt: true, stripeInvoiceId: true, creditLimit: true },
              })
            : [];
          // Usage without explicit attribution near the paid period: after recovery it is counted
          // against the new cycle by legacy attribution (e.g. interim staff-override bookings).
          const windowStart = new Date(now.getTime() - 60 * DAY_MS);
          const windowEnd = new Date(now.getTime() + 60 * DAY_MS);
          const unattributedBookings = subscription
            ? await tx.booking.findMany({
                where: {
                  studioId: subscription.studioId, userId: subscription.userId, subscriptionId: null,
                  status: { in: ['CONFIRMED', 'COMPLETED'] }, scheduledClass: { startsAt: { gte: windowStart, lt: windowEnd } },
                },
                select: { id: true, status: true, scheduledClass: { select: { startsAt: true } } },
              })
            : [];
          const unattributedAttendances = subscription
            ? await tx.attendance.findMany({
                where: {
                  studioId: subscription.studioId, userId: subscription.userId, subscriptionId: null, type: 'CLASS',
                  scheduledClass: { startsAt: { gte: windowStart, lt: windowEnd } },
                },
                select: { id: true, scheduledClass: { select: { startsAt: true } } },
              })
            : [];
          perInvoice[invoiceId] = {
            subscription, cycles, cycleForInvoice, payments, storedEvents, customerUser, studioMembership,
            siblings, siblingCycles, unattributedBookings, unattributedAttendances,
          };
        }

        // Studio-wide scan for every paid fixed-duration invoice without its cycle.
        const studios = await tx.studio.findMany({ where: { deletedAt: null }, select: { id: true, slug: true } });
        const scan: Array<PaidWithoutEntitlement & { studioSlug: string }> = [];
        for (const studio of studios) {
          for (const finding of await loadPaidWithoutEntitlement(tx, { studioId: studio.id })) scan.push({ ...finding, studioSlug: studio.slug });
        }

        // Preflight inputs: every fixed-duration plan and its live Stripe subscriptions.
        const fixedPlans = await tx.membershipPlan.findMany({
          where: { entitlementDays: { not: null }, deletedAt: null },
          select: { id: true, studioId: true, name: true, entitlementDays: true, stripePriceId: true, stripeProductId: true },
        });
        const liveFixedSubscriptions = await tx.subscription.findMany({
          where: {
            membershipPlanId: { in: fixedPlans.map((p) => p.id) },
            source: SubscriptionSource.STRIPE,
            status: { in: RENEWABLE_SUBSCRIPTION_STATUSES },
            stripeSubscriptionId: { not: null },
          },
          select: { id: true, membershipPlanId: true, stripeSubscriptionId: true },
        });
        // Live card subscriptions on NON-fixed plans: none may be billed at a fixed plan's
        // Price/Product (that would make the plan-switch race guard dead-letter their renewals).
        // Only studios that sell a fixed-duration plan run the plan-switch guard.
        const liveOtherSubscriptions = await tx.subscription.findMany({
          where: {
            studioId: { in: [...new Set(fixedPlans.map((p) => p.studioId))] },
            source: SubscriptionSource.STRIPE,
            status: { in: RENEWABLE_SUBSCRIPTION_STATUSES },
            stripeSubscriptionId: { not: null },
            membershipPlan: { entitlementDays: null },
          },
          select: { id: true, stripeSubscriptionId: true },
        });
        return { readOnly, perInvoice, scan, fixedPlans, liveFixedSubscriptions, liveOtherSubscriptions };
      },
      { timeout: 120_000, maxWait: 10_000 },
    );

    // ── Preflight (GET only): fixed-duration plans vs their Stripe Prices ───
    const preflight: Check[] = [];
    for (const plan of db.fixedPlans) {
      if (!plan.stripePriceId) {
        preflight.push({ name: `plan ${plan.id} catalog price`, ok: true, detail: 'no Stripe Price (not sold by card)' });
        continue;
      }
      const price = await stripe.retrievePrice(plan.stripePriceId);
      const productId = typeof price.product === 'string' ? price.product : price.product.id;
      const recurringOk = price.recurring?.interval === 'day' && price.recurring.interval_count === plan.entitlementDays;
      preflight.push({
        name: `plan ${plan.id} catalog price ${price.id}`,
        ok: productId === plan.stripeProductId && recurringOk && price.active,
        detail: `product ${productId} (plan ${String(plan.stripeProductId)}), recurring ${price.recurring?.interval_count ?? '?'} ${price.recurring?.interval ?? '?'} (plan ${String(plan.entitlementDays)} days), active=${String(price.active)}`,
      });
    }
    for (const sub of db.liveFixedSubscriptions) {
      const plan = db.fixedPlans.find((p) => p.id === sub.membershipPlanId)!;
      let live: Stripe.Subscription;
      try {
        live = await stripe.retrieveSubscription(sub.stripeSubscriptionId!);
      } catch (err) {
        preflight.push({ name: `subscription ${sub.id} item price`, ok: false, detail: `Stripe lookup failed: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }
      const item = live.items.data[0];
      const productId = item ? (typeof item.price.product === 'string' ? item.price.product : item.price.product.id) : null;
      const sameProduct = productId !== null && productId === plan.stripeProductId;
      const recurringOk = item?.price.recurring?.interval === 'day' && item.price.recurring.interval_count === plan.entitlementDays;
      preflight.push({
        name: `subscription ${sub.id} item price`,
        ok: live.items.data.length === 1 && sameProduct && recurringOk,
        detail: `${live.items.data.length} item(s); price ${item?.price.id ?? '?'} product ${String(productId)} (plan ${String(plan.stripeProductId)}); recurring ${item?.price.recurring?.interval_count ?? '?'} ${item?.price.recurring?.interval ?? '?'}; stripe status ${live.status}`,
      });
    }

    const fixedPriceIds = new Set(db.fixedPlans.map((p) => p.stripePriceId).filter((id): id is string => !!id));
    const fixedProductIds = new Set(db.fixedPlans.map((p) => p.stripeProductId).filter((id): id is string => !!id));
    const overlapping: string[] = [];
    const unretrievable: string[] = [];
    for (const sub of db.liveOtherSubscriptions) {
      let live: Stripe.Subscription;
      try {
        live = await stripe.retrieveSubscription(sub.stripeSubscriptionId!);
      } catch {
        unretrievable.push(`${sub.id}:${sub.stripeSubscriptionId}`); // e.g. demo/review rows without a real Stripe object
        continue;
      }
      for (const item of live.items.data) {
        const productId = typeof item.price.product === 'string' ? item.price.product : item.price.product.id;
        if (fixedPriceIds.has(item.price.id) || fixedProductIds.has(productId)) overlapping.push(`${sub.id}:${item.price.id}/${productId}`);
      }
    }
    preflight.push({
      name: `non-fixed live card subscriptions billed at a fixed plan Price/Product (${db.liveOtherSubscriptions.length - unretrievable.length} checked)`,
      ok: overlapping.length === 0,
      detail: overlapping.join(', ') || 'none',
    });
    if (unretrievable.length) {
      preflight.push({ name: 'local card rows without a Stripe subscription', ok: false, blocking: false, detail: unretrievable.join(', ') });
    }

    // ── Verdicts (pure) ─────────────────────────────────────────────────────
    const report: Record<string, unknown> = { generatedAt: now.toISOString(), databaseTransactionReadOnly: db.readOnly, invoices: {} };
    let allSafe = true;
    for (const invoiceId of targets) {
      const s = stripeFacts[invoiceId];
      const l = db.perInvoice[invoiceId] as {
        subscription: SubscriptionWithPlan | null;
        cycles: CycleRow[];
        cycleForInvoice: { id: string; subscriptionId: string; startsAt: Date; endsAt: Date; stripeInvoiceId: string | null } | null;
        payments: Array<{ id: string; status: string; amountCents: number; currency: string; subscriptionId: string | null; stripePaymentIntentId: string | null }>;
        storedEvents: Array<{ stripe_event_id: string; processed: boolean; attempt_count: number; last_error: string | null; resolved_at: Date | null; payload: unknown }>;
        customerUser: { id: string } | null;
        studioMembership: { id: string } | null;
        siblings: Array<{ id: string; status: SubscriptionStatus; source: SubscriptionSource; entitlementEndsAt: Date | null; currentPeriodEnd: Date | null }>;
        siblingCycles: CycleRow[];
        unattributedBookings: Array<{ id: string; scheduledClass: { startsAt: Date } }>;
        unattributedAttendances: Array<{ id: string; scheduledClass: { startsAt: Date } | null }>;
      };
      const checks: Check[] = [];
      const intents = s['intents'] as Array<{ id: string; status: string; refunded: boolean | null; amountRefunded: number | null; disputed: boolean | null }>;
      const creditNotes = s['creditNotes'] as unknown[];
      checks.push({ name: 'stripe_invoice_paid', ok: s['status'] === 'paid' && (s['amountRemaining'] as number) === 0, detail: `status=${String(s['status'])} amount_paid=${String(s['amountPaid'])} ${String(s['currency'])} remaining=${String(s['amountRemaining'])}` });
      checks.push({ name: 'single_succeeded_payment_intent', ok: intents.length === 1 && intents[0].status === 'succeeded', detail: intents.map((i) => `${i.id}:${i.status}`).join(', ') || 'none' });
      checks.push({ name: 'no_refund_or_dispute', ok: intents.every((i) => i.refunded === false && (i.amountRefunded ?? 0) === 0 && i.disputed === false), detail: intents.map((i) => `refunded=${String(i.refunded)} amount_refunded=${String(i.amountRefunded)} disputed=${String(i.disputed)}`).join('; ') });
      checks.push({ name: 'no_credit_notes', ok: creditNotes.length === 0, detail: `${creditNotes.length} credit note(s)` });

      const sub = l.subscription;
      checks.push({ name: 'local_subscription_linked', ok: !!sub && sub.stripeSubscriptionId === s['subscriptionId'], detail: sub ? `local ${sub.id} ↔ ${String(sub.stripeSubscriptionId)} status=${sub.status}` : `no local row for ${String(s['subscriptionId'])}` });
      checks.push({ name: 'handler_resolves_customer', ok: !!l.customerUser && !!sub && l.customerUser.id === sub.userId, detail: `invoice customer ${String(s['customerId'])} → user ${l.customerUser?.id ?? 'none'} (subscription user ${sub?.userId ?? '?'})` });
      checks.push({ name: 'handler_resolves_studio_membership', ok: !!l.studioMembership, detail: l.studioMembership ? 'active studio membership' : 'no active studio membership' });
      checks.push({ name: 'fixed_duration_plan', ok: !!sub?.membershipPlan.entitlementDays, detail: sub ? `entitlementDays=${String(sub.membershipPlan.entitlementDays)} classCredits=${String(sub.membershipPlan.classCredits)}` : 'n/a' });
      checks.push({
        name: 'subscription_not_superseded',
        ok: !!sub && sub.supersededBySubscriptionId === null && !(sub.endReason && SUPERSEDED_REASONS.includes(sub.endReason)),
        detail: sub ? `status=${sub.status} endReason=${String(sub.endReason)} supersededBy=${String(sub.supersededBySubscriptionId)}` : 'n/a',
      });
      // A re-delivery is only processed when the stored event is still open: processed or
      // operator-resolved events are silent no-ops (stripe-webhook-idempotency.ts).
      const storedEvent = l.storedEvents[0];
      checks.push({
        name: 'stored_event_replayable',
        ok: l.storedEvents.length === 1 && storedEvent.processed === false && storedEvent.resolved_at === null,
        detail: storedEvent ? `${storedEvent.stripe_event_id} processed=${String(storedEvent.processed)} resolved_at=${String(storedEvent.resolved_at)} attempts=${storedEvent.attempt_count}` : 'no stored invoice.paid event',
      });
      checks.push({ name: 'exactly_one_payment_row', ok: l.payments.length === 1 && l.payments[0].status === 'SUCCEEDED' && l.payments[0].amountCents === s['amountPaid'], detail: l.payments.map((p) => `${p.id}:${p.status}:${p.amountCents}`).join(', ') || 'none' });
      checks.push({ name: 'no_cycle_for_invoice_yet', ok: l.cycleForInvoice === null, detail: l.cycleForInvoice ? `cycle ${l.cycleForInvoice.id} exists` : 'none' });
      const entitledOrPendingSiblings = l.siblings.filter(
        (x) => RENEWABLE_SUBSCRIPTION_STATUSES.includes(x.status) || x.status === SubscriptionStatus.SCHEDULED ||
          (x.status === SubscriptionStatus.CANCELED && x.entitlementEndsAt !== null && x.entitlementEndsAt > now),
      );
      checks.push({
        name: 'no_sibling_row_in_same_family',
        ok: entitledOrPendingSiblings.length === 0,
        detail: entitledOrPendingSiblings.map((x) => `${x.id}:${x.source}:${x.status}`).join(', ') || 'none',
      });

      let live: FixedDurationDecision | null = null;
      let stored: FixedDurationDecision | null = null;
      let plan: CycleInsertionPlan | null = null;
      if (sub?.membershipPlan.entitlementDays) {
        const terms = {
          stripeSubscriptionId: sub.stripeSubscriptionId,
          planId: sub.membershipPlanId,
          hasPendingPlanChange: sub.pendingMembershipPlanId != null,
          plan: { entitlementDays: sub.membershipPlan.entitlementDays, classCredits: sub.membershipPlan.classCredits, stripePriceId: sub.membershipPlan.stripePriceId, stripeProductId: sub.membershipPlan.stripeProductId },
        };
        const invoice = s['invoice'] as Stripe.Invoice;
        live = classifyFixedDurationInvoice(
          {
            invoiceId, status: invoice.status, billingReason: invoice.billing_reason, amountPaid: invoice.amount_paid,
            invoiceSubscriptionId: readStripeInvoiceSubscriptionId(invoice), invoiceSubscriptionPlanId: s['checkoutPlanId'] as string | null, lines: invoice.lines,
          },
          terms,
        );
        const storedPayload = l.storedEvents[0]?.payload as { data?: { object?: WebhookInvoicePayload } } | undefined;
        const storedInvoice = storedPayload?.data?.object;
        if (storedInvoice) {
          stored = classifyFixedDurationInvoice(
            {
              invoiceId, status: storedInvoice.status, billingReason: storedInvoice.billing_reason ?? null, amountPaid: storedInvoice.amount_paid ?? 0,
              invoiceSubscriptionId: readInvoiceSubscriptionId(storedInvoice),
              invoiceSubscriptionPlanId: storedInvoice.parent?.subscription_details?.metadata?.['planId'] ?? null,
              lines: storedInvoice.lines,
            },
            terms,
          );
        }
        if (live.kind === 'grant') {
          const candidate = buildPaidFixedEntitlementCycle({ periodStart: live.periodStart, periodEnd: live.periodEnd, entitlementDays: sub.membershipPlan.entitlementDays, creditLimit: live.creditLimit });
          plan = planPaidCycleInsertion({ subscriptionId: sub.id, candidate, existingForInvoice: l.cycleForInvoice, existingForSubscription: l.cycles });
          const overlappingSiblingCycles = l.siblingCycles.filter((c) => c.startsAt < candidate.endsAt && c.endsAt > candidate.startsAt);
          checks.push({
            name: 'no_overlapping_cycle_on_sibling_rows',
            ok: overlappingSiblingCycles.length === 0,
            detail: overlappingSiblingCycles.map((c) => `${c.id}@${c.subscriptionId}`).join(', ') || 'none',
          });
          const inWindow = (at: Date | null | undefined) => !!at && at >= candidate.startsAt && at < candidate.endsAt;
          const nullUsage = [
            ...l.unattributedBookings.filter((b) => inWindow(b.scheduledClass.startsAt)).map((b) => `booking ${b.id} @ ${b.scheduledClass.startsAt.toISOString()}`),
            ...l.unattributedAttendances.filter((a) => inWindow(a.scheduledClass?.startsAt)).map((a) => `attendance ${a.id} @ ${a.scheduledClass!.startsAt.toISOString()}`),
          ];
          checks.push({
            name: 'unattributed_usage_in_new_window',
            ok: nullUsage.length === 0,
            blocking: false,
            detail: nullUsage.length ? `${nullUsage.length} item(s) will count against the new cycle: ${nullUsage.join('; ')}` : 'none',
          });
        }
      }
      checks.push({ name: 'live_invoice_grants_one_period', ok: live?.kind === 'grant', detail: live ? JSON.stringify(summarizeDecision(live)) : 'not evaluated' });
      checks.push({
        name: 'stored_webhook_payload_agrees',
        ok: !!stored && stored.kind === 'grant' && live?.kind === 'grant' && stored.periodStart.getTime() === live.periodStart.getTime() && stored.periodEnd.getTime() === live.periodEnd.getTime(),
        detail: stored ? JSON.stringify(summarizeDecision(stored)) : 'no stored invoice.paid event',
      });
      checks.push({ name: 'cycle_insertion_safe', ok: plan?.action === 'insert', detail: JSON.stringify(summarizePlan(plan)) });
      const expected = INCIDENT_EXPECTATIONS[invoiceId];
      if (expected && plan?.action === 'insert') {
        checks.push({
          name: 'matches_audited_expectation',
          ok: plan.cycle.startsAt.toISOString() === expected.startsAt && plan.cycle.endsAt.toISOString() === expected.endsAt && plan.cycle.creditLimit === expected.credits,
          detail: `expected ${expected.startsAt}..${expected.endsAt} x${expected.credits}`,
        });
      }

      const safe = checks.every((c) => c.ok || c.blocking === false);
      allSafe = allSafe && safe;
      (report['invoices'] as Record<string, unknown>)[invoiceId] = {
        verdict: safe ? 'SAFE_TO_RECOVER' : plan?.action === 'already_granted' ? 'ALREADY_RECOVERED' : 'NOT_SAFE',
        checks,
        stripe: { ...s, invoice: undefined },
        local: {
          subscription: sub ? { id: sub.id, status: sub.status, stripeSubscriptionId: sub.stripeSubscriptionId, currentPeriodStart: sub.currentPeriodStart, currentPeriodEnd: sub.currentPeriodEnd, entitlementEndsAt: sub.entitlementEndsAt, cancelAtPeriodEnd: sub.cancelAtPeriodEnd, planId: sub.membershipPlanId } : null,
          cycles: l.cycles,
          payments: l.payments,
          storedEvents: l.storedEvents.map((e) => ({ id: e.stripe_event_id, processed: e.processed, attempts: e.attempt_count, lastError: e.last_error, resolvedAt: e.resolved_at })),
        },
        wouldChange: plan?.action === 'insert'
          ? {
              insertCycle: summarizePlan(plan),
              subscriptionUpdate: plan.mode === 'live'
                ? { status: sub && RENEWABLE_SUBSCRIPTION_STATUSES.includes(sub.status) ? 'ACTIVE' : `${sub?.status} (unchanged)`, currentPeriodStart: plan.cycle.startsAt.toISOString(), currentPeriodEnd: plan.cycle.endsAt.toISOString(), entitlementEndsAt: plan.cycle.endsAt.toISOString() }
                : 'none (historical gap fill)',
              payment: `existing row ${l.payments[0]?.id ?? '?'} updated in place by stripeInvoiceId (no new row); stripePaymentIntentId would be set to ${intents[0]?.id ?? 'null'} if empty`,
              stripe: 'no Stripe write of any kind',
            }
          : null,
      };
    }
    const scanMatchesTargets = db.scan.length === targets.length && db.scan.every((f) => targets.includes(f.stripeInvoiceId));
    const preflightClean = preflight.every((c) => c.ok || c.blocking === false);
    report['studioWideScan'] = db.scan.map((f) => ({ studio: f.studioSlug, paymentId: f.paymentId, subscriptionId: f.subscriptionId, stripeInvoiceId: f.stripeInvoiceId, amountCents: f.amountCents, currency: f.currency, paidAt: f.paidAt.toISOString() }));
    report['scanMatchesTargets'] = scanMatchesTargets;
    report['preflight'] = preflight;
    report['overall'] = allSafe && scanMatchesTargets && preflightClean
      ? 'ALL_TARGETS_SAFE_TO_RECOVER'
      : !allSafe ? 'NOT_ALL_SAFE' : !scanMatchesTargets ? 'TARGETS_SAFE_BUT_SCAN_HAS_OTHER_FINDINGS' : 'TARGETS_SAFE_BUT_PREFLIGHT_FAILED';

    if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2));
    for (const [invoiceId, r] of Object.entries(report['invoices'] as Record<string, { verdict: string; checks: Check[] }>)) {
      console.log(`\n${invoiceId}: ${r.verdict}`);
      for (const c of r.checks) console.log(`  [${c.ok ? 'PASS' : c.blocking === false ? 'INFO' : 'FAIL'}] ${c.name} — ${c.detail.slice(0, 220)}`);
    }
    console.log('\nPreflight (fixed-duration plans and live Stripe subscriptions):');
    for (const c of preflight) console.log(`  [${c.ok ? 'PASS' : c.blocking === false ? 'INFO' : 'FAIL'}] ${c.name} — ${c.detail}`);
    console.log(`\nStudio-wide paid-without-entitlement findings: ${db.scan.length} (matches targets: ${String(scanMatchesTargets)})`);
    console.log(`Database transaction read-only: ${db.readOnly}`);
    console.log(`OVERALL: ${String(report['overall'])}`);
    process.exitCode = report['overall'] === 'ALL_TARGETS_SAFE_TO_RECOVER' ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('DRY_RUN_ERROR', err instanceof Error ? err.message : err);
  process.exitCode = 2;
});
