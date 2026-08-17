/**
 * Read-only audit: MEMBER-role users who have no WaiverAcceptance for their studio's
 * active waiver document.
 *
 * Usage (from repo root):
 *   pnpm --filter api exec ts-node --transpile-only scripts/audit-waiver-acceptances.ts
 *   # or via Railway for production DB:
 *   railway run pnpm --filter api exec ts-node --transpile-only scripts/audit-waiver-acceptances.ts
 *
 * Optional env filters:
 *   AUDIT_STUDIO_ID=...    — limit to one studio
 *   AUDIT_MEMBER_EMAIL=... — limit to one user
 *
 * Output: one JSON line per flagged member (stdout), summary (stderr).
 *
 * SAFETY: strictly read-only. No writes, updates, or deletes.
 *
 * Classification:
 *   A = DEFINITELY_NEEDS_WAIVER     — joined after waiver became active; likely BUG-1/BUG-3 victim
 *   B = HISTORICAL_LEGACY           — joined before waiver became active; not a bug victim
 *   C = HAS_HISTORICAL_ACCEPTANCE   — accepted a now-inactive document; system still requires re-acceptance
 *   D = AMBIGUOUS                   — manual review required (e.g. join date = effective date)
 */
import { PrismaClient } from '@prisma/client';

type Classification = 'A' | 'B' | 'C' | 'D';

function classify(
  membershipJoinedAt: Date,
  waiverEffectiveAt: Date,
  hasHistoricalAcceptance: boolean,
): { code: Classification; label: string } {
  const joinMs = membershipJoinedAt.getTime();
  const effectiveMs = waiverEffectiveAt.getTime();

  // If the member has accepted a superseded document, they need the current one too,
  // but the fact that they previously accepted signals intentional engagement.
  if (hasHistoricalAcceptance) {
    return {
      code: 'C',
      label: 'HAS_HISTORICAL_ACCEPTANCE — accepted a prior document; must re-accept current version',
    };
  }

  // Joined clearly before the waiver was activated → legacy member, not a bug victim.
  if (joinMs < effectiveMs - 60_000) {
    return {
      code: 'B',
      label: 'HISTORICAL_LEGACY — member predates the waiver; not a BUG-1/BUG-3 candidate',
    };
  }

  // Joined clearly after the waiver was activated → should have gone through registration waiver flow.
  if (joinMs > effectiveMs + 60_000) {
    return {
      code: 'A',
      label: 'DEFINITELY_NEEDS_WAIVER — joined after waiver active; likely BUG-1 or BUG-3 victim',
    };
  }

  // Join date is within 60s of effective date — ambiguous boundary.
  return {
    code: 'D',
    label: 'AMBIGUOUS — join date near waiver effective date; manual review required',
  };
}

async function main() {
  const prisma = new PrismaClient({ log: [] });
  const studioFilter = process.env.AUDIT_STUDIO_ID?.trim();
  const emailFilter = process.env.AUDIT_MEMBER_EMAIL?.trim().toLowerCase();

  try {
    // 1. Find all studios that currently have an active waiver document.
    const studiosWithActiveWaiver = await prisma.studioWaiverDocument.findMany({
      where: {
        isActive: true,
        ...(studioFilter ? { studioId: studioFilter } : {}),
      },
      select: {
        id: true,
        studioId: true,
        version: true,
        title: true,
        effectiveAt: true,
        studio: { select: { id: true, name: true, slug: true } },
      },
    });

    if (studiosWithActiveWaiver.length === 0) {
      process.stderr.write('No studios with an active waiver document found. Nothing to audit.\n');
      return;
    }

    const totals: Record<Classification, number> = { A: 0, B: 0, C: 0, D: 0 };

    for (const doc of studiosWithActiveWaiver) {
      // 2. All active MEMBER memberships for this studio.
      const memberships = await prisma.studioMembership.findMany({
        where: {
          studioId: doc.studioId,
          role: 'MEMBER',
          deletedAt: null,
          ...(emailFilter ? { user: { email: emailFilter } } : {}),
        },
        select: {
          userId: true,
          createdAt: true,
          user: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
              createdAt: true,
            },
          },
        },
      });

      if (memberships.length === 0) continue;

      const memberUserIds = memberships.map((m) => m.userId);

      // 3. Which of those have accepted the CURRENT active document?
      const activeAcceptances = await prisma.waiverAcceptance.findMany({
        where: {
          studioId: doc.studioId,
          waiverDocumentId: doc.id,
          userId: { in: memberUserIds },
        },
        select: { userId: true, method: true, acceptedAt: true },
      });
      const activeAcceptedUserIds = new Set(activeAcceptances.map((a) => a.userId));

      // 4. Among those missing the current acceptance, do they have ANY prior acceptance?
      //    (accepted a now-superseded document version)
      const missingIds = memberUserIds.filter((id) => !activeAcceptedUserIds.has(id));
      const historicalAcceptances = missingIds.length > 0
        ? await prisma.waiverAcceptance.findMany({
            where: {
              studioId: doc.studioId,
              userId: { in: missingIds },
              // Explicitly NOT filtering by waiverDocumentId — we want any historical acceptance
            },
            select: { userId: true, waiverDocumentId: true, acceptedAt: true, method: true },
          })
        : [];

      // Group historical acceptances by userId for O(1) lookup.
      const historicalByUser = new Map<string, typeof historicalAcceptances>();
      for (const ha of historicalAcceptances) {
        const arr = historicalByUser.get(ha.userId) ?? [];
        arr.push(ha);
        historicalByUser.set(ha.userId, arr);
      }

      // 5. Emit flagged members.
      const missing = memberships.filter((m) => !activeAcceptedUserIds.has(m.userId));

      for (const m of missing) {
        const historical = historicalByUser.get(m.userId) ?? [];
        const hasHistoricalAcceptance = historical.length > 0;
        const { code, label } = classify(
          m.createdAt,
          doc.effectiveAt,
          hasHistoricalAcceptance,
        );

        totals[code]++;

        process.stdout.write(
          JSON.stringify({
            classification: code,
            classificationLabel: label,
            studioId: doc.studioId,
            studioSlug: doc.studio.slug,
            studioName: doc.studio.name,
            activeWaiverDocumentId: doc.id,
            activeWaiverVersion: doc.version,
            activeWaiverTitle: doc.title,
            waiverEffectiveAt: doc.effectiveAt,
            userId: m.user.id,
            email: m.user.email,
            firstName: m.user.firstName,
            lastName: m.user.lastName,
            userCreatedAt: m.user.createdAt,
            membershipJoinedAt: m.createdAt,
            memberPredatesWaiver: m.createdAt.getTime() < doc.effectiveAt.getTime(),
            hasHistoricalAcceptance,
            historicalAcceptances: historical.map((ha) => ({
              waiverDocumentId: ha.waiverDocumentId,
              method: ha.method,
              acceptedAt: ha.acceptedAt,
            })),
            suspicionReason:
              code === 'A'
                ? 'Joined after waiver effective date but has no acceptance record; possible BUG-1/BUG-3 victim'
                : code === 'B'
                  ? 'Joined before waiver was introduced; legacy member who has not yet been prompted'
                  : code === 'C'
                    ? 'Has acceptance for a prior (now inactive) waiver version; system requires current version'
                    : 'Join date is within 60s of waiver effective date; boundary ambiguity',
          }) + '\n',
        );
      }
    }

    // 6. Summary.
    const total = totals.A + totals.B + totals.C + totals.D;
    process.stderr.write(
      `\nAudit complete.\n` +
        `  Studios with active waiver: ${studiosWithActiveWaiver.length}\n` +
        `  Total missing current acceptance: ${total}\n` +
        `  A (DEFINITELY_NEEDS_WAIVER / BUG candidates): ${totals.A}\n` +
        `  B (HISTORICAL_LEGACY / pre-waiver members):   ${totals.B}\n` +
        `  C (HAS_HISTORICAL_ACCEPTANCE / superseded):   ${totals.C}\n` +
        `  D (AMBIGUOUS / manual review):                ${totals.D}\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${String(err)}\n`);
  process.exit(1);
});
