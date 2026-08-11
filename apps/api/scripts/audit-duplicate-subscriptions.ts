/**
 * Read-only audit: members with more than one renewable subscription in the same studio.
 *
 * Usage (from repo root):
 *   pnpm --filter api exec ts-node --transpile-only scripts/audit-duplicate-subscriptions.ts
 *
 * Optional filters:
 *   AUDIT_STUDIO_ID=... AUDIT_MEMBER_EMAIL=... pnpm --filter api exec ts-node ...
 */
import { PrismaClient, SubscriptionStatus } from '@prisma/client';

const RENEWABLE: SubscriptionStatus[] = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.TRIALING,
  SubscriptionStatus.PAST_DUE,
  SubscriptionStatus.PAUSED,
];

async function main() {
  const prisma = new PrismaClient();
  const studioFilter = process.env.AUDIT_STUDIO_ID;
  const emailFilter = process.env.AUDIT_MEMBER_EMAIL?.trim().toLowerCase();

  try {
    const subs = await prisma.subscription.findMany({
      where: {
        status: { in: RENEWABLE },
        ...(studioFilter ? { studioId: studioFilter } : {}),
        ...(emailFilter
          ? {
              user: { email: emailFilter },
            }
          : {}),
      },
      orderBy: [{ studioId: 'asc' }, { userId: 'asc' }, { createdAt: 'asc' }],
      include: {
        membershipPlan: { select: { id: true, name: true, priceCents: true, currency: true } },
        user: { select: { id: true, email: true, firstName: true, lastName: true } },
        studio: { select: { id: true, name: true, slug: true } },
      },
    });

    const grouped = new Map<string, typeof subs>();
    for (const sub of subs) {
      const key = `${sub.studioId}:${sub.userId}`;
      const list = grouped.get(key) ?? [];
      list.push(sub);
      grouped.set(key, list);
    }

    const duplicates = [...grouped.entries()].filter(([, list]) => list.length > 1);

    if (duplicates.length === 0) {
      console.log('No duplicate current subscriptions found.');
      return;
    }

    console.log(`Found ${duplicates.length} member(s) with multiple renewable subscriptions:\n`);

    for (const [, memberSubs] of duplicates) {
      const first = memberSubs[0]!;
      console.log('─'.repeat(72));
      console.log(
        `Member: ${first.user.firstName} ${first.user.lastName} <${first.user.email}>`,
      );
      console.log(`Studio: ${first.studio.name} (${first.studio.slug})`);
      console.log(`Renewable subscription count: ${memberSubs.length}`);

      for (const sub of memberSubs) {
        console.log(
          [
            `  • ${sub.membershipPlan.name}`,
            `status=${sub.status}`,
            `source=${sub.source}`,
            `cancelAtPeriodEnd=${sub.cancelAtPeriodEnd}`,
            `stripeSubscriptionId=${sub.stripeSubscriptionId ?? '—'}`,
            `periodEnd=${sub.currentPeriodEnd?.toISOString() ?? '—'}`,
            `createdAt=${sub.createdAt.toISOString()}`,
            `localId=${sub.id}`,
          ].join(' | '),
        );
      }
    }

    console.log('\nAudit complete. No subscriptions were modified.');
  } finally {
    await prisma.$disconnect();
  }
}

void main();
