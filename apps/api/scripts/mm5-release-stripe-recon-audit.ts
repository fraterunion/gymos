import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
const p = new PrismaClient();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const ARES = 'cmp33m0gp0000qomlj9p42ia5';
const RENEWABLE_STRIPE = new Set(['active', 'trialing', 'past_due', 'paused']);

/**
 * Known intentional pending stacks awaiting Stage-5b reconciliation. These are printed
 * explicitly and counted separately — NEVER silently suppressed — and any OTHER paid
 * orphan remains a release blocker. After the local repair the subscription has a local
 * row, is no longer orphaned, and the whitelist entry becomes inert (match count 0).
 */
const KNOWN_PENDING_MULTI_MEMBERSHIP_RECONCILIATION = new Set<string>([
  // Ivonne — intentional Booty(cash) + Pro(Stripe) stack; repaired at MM Stage 5b.
  'sub_1U8iKnGuUoCXNOREVnsNhHEc',
]);
async function main() {
  const localStripe = await p.subscription.findMany({
    where: { studioId: ARES, stripeSubscriptionId: { not: null } },
    select: { id: true, userId: true, status: true, stripeSubscriptionId: true, cancelAtPeriodEnd: true },
  });
  const memberUsers = (await p.$queryRawUnsafe(
    `SELECT u.id, u.stripe_customer_id FROM users u JOIN studio_memberships sm ON sm.user_id=u.id WHERE sm.studio_id='${ARES}' AND u.stripe_customer_id IS NOT NULL`,
  )) as Array<{ id: string; stripe_customer_id: string }>;
  const custByUser = new Map(memberUsers.map((u) => [u.id, u.stripe_customer_id]));
  const localByStripeId = new Map(localStripe.map((s) => [s.stripeSubscriptionId!, s]));

  let liveRenewable = 0, orphans = 0, localOrphans = 0, capeMismatch = 0, statusMismatch = 0, metaAnomaly = 0, multi = 0, knownPending = 0;
  const perUserLive = new Map<string, number>();
  let invalidCustomers = 0;
  for (const [userId, custId] of custByUser) {
    let subs;
    try {
      subs = await stripe.subscriptions.list({ customer: custId, status: 'all', limit: 100 });
    } catch (e) {
      invalidCustomers++;
      console.log('INVALID_CUSTOMER_ID:', custId, 'user:', userId, '-', e instanceof Error ? e.message : e);
      continue;
    }
    for (const sub of subs.data) {
      if (sub.metadata?.studioId && sub.metadata.studioId !== ARES) continue;
      const local = localByStripeId.get(sub.id);
      if (RENEWABLE_STRIPE.has(sub.status)) {
        liveRenewable++;
        perUserLive.set(userId, (perUserLive.get(userId) ?? 0) + 1);
        if (!local) {
          if (KNOWN_PENDING_MULTI_MEMBERSHIP_RECONCILIATION.has(sub.id)) {
            knownPending++;
            console.log('KNOWN_PENDING_MULTI_MEMBERSHIP_RECONCILIATION:', sub.id, sub.status, '(NOT counted as generic orphan — resolve at Stage 5b)');
          } else {
            orphans++;
            console.log('STRIPE_ORPHAN:', sub.id, sub.status);
          }
        }
        else {
          if (local.cancelAtPeriodEnd !== sub.cancel_at_period_end) { capeMismatch++; console.log('CAPE_MISMATCH:', sub.id, 'local', local.cancelAtPeriodEnd, 'stripe', sub.cancel_at_period_end); }
          const map: Record<string, string> = { active: 'ACTIVE', trialing: 'TRIALING', past_due: 'PAST_DUE', paused: 'PAUSED' };
          if (map[sub.status] && local.status !== map[sub.status]) { statusMismatch++; console.log('STATUS_MISMATCH:', sub.id, 'local', local.status, 'stripe', sub.status); }
        }
        if (!sub.metadata?.userId || !sub.metadata?.studioId) { metaAnomaly++; console.log('META_ANOMALY:', sub.id, JSON.stringify(sub.metadata)); }
      }
    }
  }
  for (const l of localStripe) {
    if (!['ACTIVE', 'TRIALING', 'PAST_DUE', 'PAUSED'].includes(l.status)) continue;
    try {
      const live = await stripe.subscriptions.retrieve(l.stripeSubscriptionId!);
      if (!RENEWABLE_STRIPE.has(live.status)) { localOrphans++; console.log('LOCAL_ORPHAN:', l.id, l.status, 'stripe:', live.status); }
    } catch { localOrphans++; console.log('LOCAL_ORPHAN_MISSING:', l.id); }
  }
  for (const [u, n] of perUserLive) if (n > 1) { multi++; console.log('MULTI_LIVE_STRIPE_USER:', u, n); }
  console.log('SUMMARY:', JSON.stringify({ liveRenewable, stripeOrphans: orphans, localOrphans, capeMismatch, statusMismatch, metaAnomaly, usersWithMultipleLiveStripe: multi, invalidCustomers, knownPendingReconciliations: knownPending }));
  await p.$disconnect();
}
main().catch((e) => { console.error('AUDIT_ERROR:', e instanceof Error ? e.message : e); process.exitCode = 1; });
