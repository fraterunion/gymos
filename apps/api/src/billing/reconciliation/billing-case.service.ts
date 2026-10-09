import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  BillingCaseCategory,
  BillingCaseSeverity,
  BillingCaseStatus,
  Prisma,
  type BillingReconciliationCase,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CASE_HISTORY_LIMIT,
  SEVERITY_RANK,
  buildIssueKey,
  type CaseHistoryEntry,
  type ObserveOutcome,
  type ObservedIssue,
} from './billing-case.types';

type Db = Prisma.TransactionClient | PrismaService;

export type ObserveResult = { outcome: ObserveOutcome; case: BillingReconciliationCase };

export type CaseListFilter = {
  status?: BillingCaseStatus[];
  severity?: BillingCaseSeverity[];
  category?: BillingCaseCategory[];
  userId?: string;
  limit?: number;
  cursor?: string | null;
};

const ACTIVE_STATUSES: BillingCaseStatus[] = [BillingCaseStatus.OPEN, BillingCaseStatus.ACKNOWLEDGED];

/**
 * Reason codes that only a webhook handler can observe (no nightly detector re-emits them), so
 * "not observed by the run" says nothing about them: operators close these.
 */
export const EVENT_ONLY_REASON_CODES: string[] = ['LATE_FIXED_WINDOW_GRANTED', 'DUPLICATE_MEMBERSHIP_PAYMENT', 'NO_LOCAL_SUBSCRIPTION'];

function appendHistory(current: unknown, entry: CaseHistoryEntry): CaseHistoryEntry[] {
  const list = Array.isArray(current) ? (current as CaseHistoryEntry[]) : [];
  const next = [...list, entry];
  return next.length > CASE_HISTORY_LIMIT ? next.slice(next.length - CASE_HISTORY_LIMIT) : next;
}

/**
 * Durable reconciliation cases. Every write is idempotent on `issueKey`, so repeated cron runs,
 * webhook retries and manual runs converge on one row per real-world issue.
 */
@Injectable()
export class BillingCaseService {
  private readonly logger = new Logger(BillingCaseService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records that `issue` was observed now. Creates an OPEN case, refreshes an active one,
   * reopens a RESOLVED one (recurrence), and leaves a DISMISSED one dismissed.
   */
  async observe(
    db: Db,
    issue: ObservedIssue,
    opts: { now?: Date; runId?: string | null } = {},
  ): Promise<ObserveResult> {
    const now = opts.now ?? new Date();
    const issueKey = buildIssueKey(issue.studioId, issue.category, issue.issueRef);
    const refs = {
      userId: issue.userId ?? null,
      subscriptionId: issue.subscriptionId ?? null,
      paymentId: issue.paymentId ?? null,
      stripeSubscriptionId: issue.stripeSubscriptionId ?? null,
      stripeInvoiceId: issue.stripeInvoiceId ?? null,
      stripeCustomerId: issue.stripeCustomerId ?? null,
      stripeEventId: issue.stripeEventId ?? null,
    };
    const evidence = issue.evidence as Prisma.InputJsonValue;

    const existing = await db.billingReconciliationCase.findUnique({ where: { issueKey } });
    if (!existing) {
      try {
        const created = await db.billingReconciliationCase.create({
          data: {
            studioId: issue.studioId,
            issueKey,
            category: issue.category,
            severity: issue.severity,
            status: BillingCaseStatus.OPEN,
            reasonCode: issue.reasonCode,
            ...refs,
            title: issue.title,
            summary: issue.summary,
            suggestedAction: issue.suggestedAction,
            evidence,
            history: [{ at: now.toISOString(), type: 'DETECTED', runId: opts.runId ?? null }] as Prisma.InputJsonValue,
            firstDetectedAt: now,
            lastObservedAt: now,
          },
        });
        this.logger.warn(
          JSON.stringify({
            event: 'billing_case_opened',
            caseId: created.id,
            studioId: issue.studioId,
            category: issue.category,
            severity: issue.severity,
            reasonCode: issue.reasonCode,
            issueRef: issue.issueRef,
          }),
        );
        return { outcome: 'created', case: created };
      } catch (err) {
        // Concurrent observer (webhook + cron) created it first: fall through to the update path.
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
      }
    }
    const row = existing ?? (await db.billingReconciliationCase.findUniqueOrThrow({ where: { issueKey } }));

    if (row.status === BillingCaseStatus.DISMISSED) {
      const updated = await db.billingReconciliationCase.update({
        where: { id: row.id },
        data: { lastObservedAt: now, observationCount: { increment: 1 }, evidence },
      });
      return { outcome: 'dismissed_unchanged', case: updated };
    }

    const severityChanged = row.severity !== issue.severity;
    const history: CaseHistoryEntry[] = [];
    if (severityChanged) {
      history.push({ at: now.toISOString(), type: 'SEVERITY_CHANGED', from: row.severity, to: issue.severity, runId: opts.runId ?? null });
    }

    if (row.status === BillingCaseStatus.RESOLVED) {
      history.push({ at: now.toISOString(), type: 'REOPENED', runId: opts.runId ?? null, note: row.resolutionNote ?? null });
      const reopened = await db.billingReconciliationCase.update({
        where: { id: row.id },
        data: {
          status: BillingCaseStatus.OPEN,
          severity: issue.severity,
          reasonCode: issue.reasonCode,
          ...refs,
          title: issue.title,
          summary: issue.summary,
          suggestedAction: issue.suggestedAction,
          evidence,
          lastObservedAt: now,
          observationCount: { increment: 1 },
          occurrenceCount: { increment: 1 },
          resolvedAt: null,
          resolvedByUserId: null,
          resolutionNote: null,
          acknowledgedAt: null,
          acknowledgedByUserId: null,
          // A recurrence must alert again.
          lastAlertedAt: null,
          escalatedAt: null,
          history: history.reduce((acc, h) => appendHistory(acc, h), row.history as unknown) as unknown as Prisma.InputJsonValue,
        },
      });
      this.logger.warn(JSON.stringify({ event: 'billing_case_reopened', caseId: row.id, studioId: issue.studioId, category: issue.category, occurrenceCount: reopened.occurrenceCount }));
      return { outcome: 'reopened', case: reopened };
    }

    // OPEN / ACKNOWLEDGED: refresh evidence and bookkeeping; a severity increase re-arms alerting.
    const escalatedSeverity = SEVERITY_RANK[issue.severity] > SEVERITY_RANK[row.severity];
    const updated = await db.billingReconciliationCase.update({
      where: { id: row.id },
      data: {
        severity: issue.severity,
        reasonCode: issue.reasonCode,
        ...refs,
        title: issue.title,
        summary: issue.summary,
        suggestedAction: issue.suggestedAction,
        evidence,
        lastObservedAt: now,
        observationCount: { increment: 1 },
        ...(escalatedSeverity ? { lastAlertedAt: null } : {}),
        ...(history.length ? { history: history.reduce((acc, h) => appendHistory(acc, h), row.history as unknown) as unknown as Prisma.InputJsonValue } : {}),
      },
    });
    return { outcome: 'updated', case: updated };
  }

  /**
   * Auto-resolves active cases in `categories` for `studioId` that a COMPLETE detector run did not
   * observe. Callers must only pass categories whose detector fully re-evaluated this run.
   * Never touches a case observed or created after the run started (a webhook may open one while
   * the run is scanning), nor a reason code only a webhook can observe.
   */
  async resolveUnobserved(
    db: Db,
    scope: {
      studioId: string | null;
      categories: BillingCaseCategory[];
      observedIssueKeys: Set<string>;
      runId: string | null;
      /** Snapshot instant of the run: cases touched after it are out of scope. */
      runStartedAt: Date;
      now?: Date;
    },
  ): Promise<number> {
    if (scope.categories.length === 0) return 0;
    const now = scope.now ?? new Date();
    const candidates = await db.billingReconciliationCase.findMany({
      where: {
        studioId: scope.studioId,
        status: { in: ACTIVE_STATUSES },
        category: { in: scope.categories },
        reasonCode: { notIn: EVENT_ONLY_REASON_CODES },
        firstDetectedAt: { lte: scope.runStartedAt },
        lastObservedAt: { lte: scope.runStartedAt },
      },
      select: { id: true, issueKey: true, history: true, category: true },
    });
    let resolved = 0;
    for (const c of candidates) {
      if (scope.observedIssueKeys.has(c.issueKey)) continue;
      await db.billingReconciliationCase.update({
        where: { id: c.id },
        data: {
          status: BillingCaseStatus.RESOLVED,
          resolvedAt: now,
          resolvedByUserId: null,
          resolutionNote: 'Ya no se observa la discrepancia (revisión automática).',
          history: appendHistory(c.history, { at: now.toISOString(), type: 'AUTO_RESOLVED', runId: scope.runId }) as unknown as Prisma.InputJsonValue,
        },
      });
      this.logger.log(JSON.stringify({ event: 'billing_case_auto_resolved', caseId: c.id, studioId: scope.studioId, category: c.category }));
      resolved += 1;
    }
    return resolved;
  }

  // ── Operator actions (always studio-scoped) ─────────────────────────────────

  async listForStudio(studioId: string, filter: CaseListFilter = {}) {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const where: Prisma.BillingReconciliationCaseWhereInput = {
      studioId,
      ...(filter.status?.length ? { status: { in: filter.status } } : {}),
      ...(filter.severity?.length ? { severity: { in: filter.severity } } : {}),
      ...(filter.category?.length ? { category: { in: filter.category } } : {}),
      ...(filter.userId ? { userId: filter.userId } : {}),
    };
    const rows = await this.prisma.billingReconciliationCase.findMany({
      where,
      orderBy: [{ status: 'asc' }, { severity: 'asc' }, { lastObservedAt: 'desc' }],
      take: limit + 1,
      ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
      include: { user: { select: { firstName: true, lastName: true } } },
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const counts = await this.prisma.billingReconciliationCase.groupBy({
      by: ['status', 'severity'],
      where: { studioId },
      _count: { _all: true },
    });
    return {
      items,
      nextCursor: hasMore ? items[items.length - 1]!.id : null,
      counts: counts.map((c) => ({ status: c.status, severity: c.severity, count: c._count._all })),
    };
  }

  async getForStudio(studioId: string, caseId: string) {
    const row = await this.prisma.billingReconciliationCase.findFirst({
      where: { id: caseId, studioId },
      include: {
        user: { select: { firstName: true, lastName: true } },
        acknowledgedBy: { select: { firstName: true, lastName: true } },
        resolvedBy: { select: { firstName: true, lastName: true } },
        dismissedBy: { select: { firstName: true, lastName: true } },
      },
    });
    if (!row) throw new NotFoundException('Case not found');
    return row;
  }

  async openCasesForMember(db: Db, studioId: string, userId: string) {
    return db.billingReconciliationCase.findMany({
      where: { studioId, userId, status: { in: ACTIVE_STATUSES } },
      orderBy: [{ severity: 'asc' }, { lastObservedAt: 'desc' }],
      select: {
        id: true, category: true, severity: true, status: true, reasonCode: true, title: true, summary: true, suggestedAction: true,
        subscriptionId: true, stripeInvoiceId: true, firstDetectedAt: true, lastObservedAt: true, acknowledgedAt: true,
      },
    });
  }

  async acknowledge(studioId: string, caseId: string, actorUserId: string, note?: string | null) {
    const row = await this.getForStudio(studioId, caseId);
    if (row.status !== BillingCaseStatus.OPEN) throw new ForbiddenException('Solo un caso abierto puede marcarse como revisado.');
    const now = new Date();
    return this.prisma.billingReconciliationCase.update({
      where: { id: row.id },
      data: {
        status: BillingCaseStatus.ACKNOWLEDGED,
        acknowledgedAt: now,
        acknowledgedByUserId: actorUserId,
        history: appendHistory(row.history, { at: now.toISOString(), type: 'ACKNOWLEDGED', byUserId: actorUserId, note: note ?? null }) as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async resolve(studioId: string, caseId: string, actorUserId: string, note: string) {
    const row = await this.getForStudio(studioId, caseId);
    if (!ACTIVE_STATUSES.includes(row.status)) throw new ForbiddenException('El caso ya no está activo.');
    const now = new Date();
    return this.prisma.billingReconciliationCase.update({
      where: { id: row.id },
      data: {
        status: BillingCaseStatus.RESOLVED,
        resolvedAt: now,
        resolvedByUserId: actorUserId,
        resolutionNote: note,
        history: appendHistory(row.history, { at: now.toISOString(), type: 'RESOLVED', byUserId: actorUserId, note }) as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async dismiss(studioId: string, caseId: string, actorUserId: string, reason: string) {
    const row = await this.getForStudio(studioId, caseId);
    if (!ACTIVE_STATUSES.includes(row.status)) throw new ForbiddenException('El caso ya no está activo.');
    const now = new Date();
    return this.prisma.billingReconciliationCase.update({
      where: { id: row.id },
      data: {
        status: BillingCaseStatus.DISMISSED,
        dismissedAt: now,
        dismissedByUserId: actorUserId,
        dismissReason: reason,
        history: appendHistory(row.history, { at: now.toISOString(), type: 'DISMISSED', byUserId: actorUserId, note: reason }) as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async reopen(studioId: string, caseId: string, actorUserId: string, note?: string | null) {
    const row = await this.getForStudio(studioId, caseId);
    if (ACTIVE_STATUSES.includes(row.status)) throw new ForbiddenException('El caso ya está activo.');
    const now = new Date();
    return this.prisma.billingReconciliationCase.update({
      where: { id: row.id },
      data: {
        status: BillingCaseStatus.OPEN,
        occurrenceCount: { increment: 1 },
        resolvedAt: null, resolvedByUserId: null, resolutionNote: null,
        dismissedAt: null, dismissedByUserId: null, dismissReason: null,
        acknowledgedAt: null, acknowledgedByUserId: null,
        lastAlertedAt: null, escalatedAt: null,
        history: appendHistory(row.history, { at: now.toISOString(), type: 'REOPENED', byUserId: actorUserId, note: note ?? null }) as unknown as Prisma.InputJsonValue,
      },
    });
  }

  /** Alert bookkeeping (called by the alert service after a delivery attempt). */
  async recordAlert(caseId: string, input: { channel: string; ok: boolean; escalation: boolean; error?: string | null; now?: Date }) {
    const now = input.now ?? new Date();
    const row = await this.prisma.billingReconciliationCase.findUnique({ where: { id: caseId }, select: { history: true } });
    if (!row) return;
    await this.prisma.billingReconciliationCase.update({
      where: { id: caseId },
      data: {
        ...(input.ok ? { lastAlertedAt: now, alertCount: { increment: 1 }, ...(input.escalation ? { escalatedAt: now } : {}) } : {}),
        history: appendHistory(row.history, {
          at: now.toISOString(),
          type: input.ok ? 'ALERT_SENT' : 'ALERT_FAILED',
          channel: input.channel,
          note: input.ok ? (input.escalation ? 'escalación' : null) : (input.error ?? 'error').slice(0, 60),
        }) as unknown as Prisma.InputJsonValue,
      },
    });
  }
}
