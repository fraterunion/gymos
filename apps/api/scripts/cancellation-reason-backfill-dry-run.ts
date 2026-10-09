/**
 * READ-ONLY dry run: which CANCELED Stripe subscriptions carry an end reason that contradicts the
 * stored `customer.subscription.deleted` event (e.g. MEMBER_CANCELLED while Stripe ended it for
 * `payment_failed`). Prints the proposed correction per row and NEVER writes — the actual backfill
 * is a separate, explicitly approved step (see docs/BILLING_RELIABILITY_RECONCILIATION.md).
 *
 *   railway run --service api npx ts-node -r tsconfig-paths/register --project tsconfig.scripts.json \
 *     scripts/cancellation-reason-backfill-dry-run.ts [--studio <id>] [--json]
 *
 * Output contains subscription/event ids and reasons only: no names, emails or card data.
 */
import { PrismaClient, SubscriptionEndReason } from '@prisma/client';

const prisma = new PrismaClient();

function expectedFromStripe(status: string | null, reason: string | null): SubscriptionEndReason | null {
  if (status === 'incomplete_expired') return SubscriptionEndReason.INCOMPLETE_EXPIRED;
  if (reason === 'payment_failed') return SubscriptionEndReason.PAYMENT_FAILED;
  if (reason === 'payment_disputed') return SubscriptionEndReason.PAYMENT_DISPUTED;
  return null;
}

type Proposal = {
  studioId: string;
  subscriptionId: string;
  stripeSubscriptionId: string;
  currentEndReason: SubscriptionEndReason | null;
  proposedEndReason: SubscriptionEndReason;
  stripeStatus: string | null;
  stripeCancellationReason: string | null;
  deletionEventId: string;
  deletionReceivedAt: string;
  rowUpdatedAt: string;
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const studioFlag = args.indexOf('--studio');
  const studioId = studioFlag >= 0 ? args[studioFlag + 1] ?? null : null;
  const json = args.includes('--json');

  const proposals = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const ro = (await tx.$queryRawUnsafe('SHOW transaction_read_only')) as Array<{ transaction_read_only: string }>;
    if (ro[0]?.transaction_read_only !== 'on') throw new Error('transaction is not read-only; aborting');

    const rows = await tx.subscription.findMany({
      where: {
        ...(studioId ? { studioId } : {}),
        status: 'CANCELED',
        source: 'STRIPE',
        stripeSubscriptionId: { not: null },
        OR: [{ endReason: null }, { endReason: SubscriptionEndReason.MEMBER_CANCELLED }],
      },
      select: { id: true, studioId: true, stripeSubscriptionId: true, endReason: true, updatedAt: true },
    });
    const byStripeId = new Map(rows.map((r) => [r.stripeSubscriptionId!, r]));

    const deletions = await tx.stripeWebhookEvent.findMany({
      where: { eventType: 'customer.subscription.deleted' },
      select: { stripeEventId: true, createdAt: true, payload: true },
      orderBy: { createdAt: 'asc' },
    });

    const out: Proposal[] = [];
    const latest = new Map<string, { eventId: string; createdAt: Date; status: string | null; reason: string | null }>();
    for (const d of deletions) {
      const obj = (d.payload as { data?: { object?: { id?: string; status?: string; cancellation_details?: { reason?: string | null } } } }).data?.object;
      if (!obj?.id || !byStripeId.has(obj.id)) continue;
      latest.set(obj.id, { eventId: d.stripeEventId, createdAt: d.createdAt, status: obj.status ?? null, reason: obj.cancellation_details?.reason ?? null });
    }
    for (const [stripeSubscriptionId, deletion] of latest) {
      const row = byStripeId.get(stripeSubscriptionId)!;
      const proposed = expectedFromStripe(deletion.status, deletion.reason);
      if (!proposed || proposed === row.endReason) continue;
      out.push({
        studioId: row.studioId,
        subscriptionId: row.id,
        stripeSubscriptionId,
        currentEndReason: row.endReason,
        proposedEndReason: proposed,
        stripeStatus: deletion.status,
        stripeCancellationReason: deletion.reason,
        deletionEventId: deletion.eventId,
        deletionReceivedAt: deletion.createdAt.toISOString(),
        rowUpdatedAt: row.updatedAt.toISOString(),
      });
    }
    return out;
  });

  if (json) {
    console.log(JSON.stringify({ mode: 'DRY_RUN_READ_ONLY', proposals }, null, 2));
  } else {
    console.log(`\nCancellation-reason backfill — DRY RUN (read-only). Proposals: ${proposals.length}`);
    for (const p of proposals) {
      console.log(`  ${p.subscriptionId}  ${p.currentEndReason ?? 'null'} → ${p.proposedEndReason}  (Stripe ${p.stripeStatus}/${p.stripeCancellationReason}, event ${p.deletionEventId})`);
    }
    console.log('\nNo rows were modified. Apply only through an explicitly approved forward migration or script.');
  }
}

main()
  .catch((err) => {
    console.error('DRY_RUN_ERROR', err instanceof Error ? err.message : err);
    process.exitCode = 2;
  })
  .finally(() => prisma.$disconnect());
