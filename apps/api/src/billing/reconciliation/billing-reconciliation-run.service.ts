import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { BillingCaseCategory, BillingReconciliationRunStatus, BillingReconciliationRunTrigger, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BillingAlertService, type AlertDispatchSummary } from './billing-alert.service';
import { BillingCaseService } from './billing-case.service';
import { SEVERITY_RANK, buildIssueKey, type ObservedIssue } from './billing-case.types';
import { BillingDetectorsService, type DetectOptions } from './billing-detectors.service';

export type StudioRunStats = {
  studioId: string;
  issues: number;
  created: number;
  reopened: number;
  updated: number;
  autoResolved: number;
  incompleteCategories: BillingCaseCategory[];
  checkedMembers: number;
  skippedMembers: number;
  stripeCalls: number;
  stripeFailures: number;
  durationMs: number;
  error: string | null;
};

export type RunSummary = {
  runId: string;
  status: BillingReconciliationRunStatus;
  trigger: BillingReconciliationRunTrigger;
  startedAt: string;
  finishedAt: string;
  studios: StudioRunStats[];
  platform: { webhookIssues: number; refundIssues: number; created: number; reopened: number; autoResolved: number; incomplete: boolean };
  alerts: AlertDispatchSummary | null;
  stripeCalls: number;
};

const STALE_RUN_MS = 3 * 60 * 60_000;
const WEBHOOK_CATEGORIES: BillingCaseCategory[] = ['WEBHOOK_DEAD_LETTER', 'WEBHOOK_BACKLOG'];

/**
 * One detection run = detect → observe cases → auto-resolve what a COMPLETE detector no longer
 * sees → dispatch alerts. Idempotent (cases key on issueKey), serialized per scope by the partial
 * unique index on billing_reconciliation_runs, and strictly detection-only: it never repairs
 * membership, payment or Stripe state.
 */
@Injectable()
export class BillingReconciliationRunService {
  private readonly logger = new Logger(BillingReconciliationRunService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly detectors: BillingDetectorsService,
    private readonly cases: BillingCaseService,
    private readonly alerts: BillingAlertService,
  ) {}

  async runStudio(studioId: string, trigger: BillingReconciliationRunTrigger, opts: DetectOptions & { dispatchAlerts?: boolean } = {}): Promise<RunSummary> {
    return this.withRun(studioId, trigger, async (runId, now) => {
      const studio = await this.processStudio(runId, studioId, now, opts);
      const platform = await this.processPlatform(runId, now, { studioId, webhooks: true, refunds: true });
      const alerts = opts.dispatchAlerts === false ? null : await this.alerts.dispatchPending({ now, studioId });
      return { studios: [studio], platform, alerts, stripeCalls: studio.stripeCalls + platform.stripeCalls };
    });
  }

  async runAllStudios(trigger: BillingReconciliationRunTrigger, opts: DetectOptions & { dispatchAlerts?: boolean } = {}): Promise<RunSummary> {
    return this.withRun(null, trigger, async (runId, now) => {
      const studios = await this.prisma.studio.findMany({ where: { deletedAt: null }, select: { id: true }, orderBy: { createdAt: 'asc' } });
      const stats: StudioRunStats[] = [];
      for (const s of studios) stats.push(await this.processStudio(runId, s.id, now, opts));
      const platform = await this.processPlatform(runId, now, { studioId: null, webhooks: true, refunds: true });
      const alerts = opts.dispatchAlerts === false ? null : await this.alerts.dispatchPending({ now });
      return { studios: stats, platform, alerts, stripeCalls: stats.reduce((n, s) => n + s.stripeCalls, 0) + platform.stripeCalls };
    });
  }

  /** Latest run covering this studio. A platform-wide run's stats are not exposed to a tenant. */
  async latestRun(studioId: string) {
    const run = await this.prisma.billingReconciliationRun.findFirst({
      where: { OR: [{ studioId }, { studioId: null }] },
      orderBy: { startedAt: 'desc' },
      select: { id: true, studioId: true, trigger: true, status: true, startedAt: true, finishedAt: true, stats: true, error: true },
    });
    if (!run) return null;
    return run.studioId === null ? { ...run, stats: { scope: 'platform' }, error: run.error ? 'see platform logs' : null } : run;
  }

  // ── internals ─────────────────────────────────────────────────────────────────

  private async withRun(
    studioId: string | null,
    trigger: BillingReconciliationRunTrigger,
    body: (runId: string, now: Date) => Promise<Pick<RunSummary, 'studios' | 'platform' | 'alerts' | 'stripeCalls'>>,
  ): Promise<RunSummary> {
    const runScope = studioId ?? '*';
    const now = new Date();
    // A crashed run must not block the scope forever.
    await this.prisma.billingReconciliationRun.updateMany({
      where: { runScope, status: BillingReconciliationRunStatus.RUNNING, startedAt: { lt: new Date(now.getTime() - STALE_RUN_MS) } },
      data: { status: BillingReconciliationRunStatus.FAILED, finishedAt: now, error: 'stale RUNNING row reclaimed by a later run' },
    });
    let run: { id: string; startedAt: Date };
    try {
      run = await this.prisma.billingReconciliationRun.create({ data: { studioId, runScope, trigger, status: BillingReconciliationRunStatus.RUNNING }, select: { id: true, startedAt: true } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({ code: 'BILLING_RECONCILIATION_RUN_IN_PROGRESS', message: 'Ya hay una revisión de facturación en curso para este alcance.' });
      }
      throw err;
    }
    this.logger.log(JSON.stringify({ event: 'billing_reconciliation_run_started', runId: run.id, scope: runScope, trigger }));
    try {
      const result = await body(run.id, now);
      const incomplete = result.studios.some((s) => s.error || s.incompleteCategories.length > 0) || result.platform.incomplete;
      const status = incomplete ? BillingReconciliationRunStatus.PARTIAL : BillingReconciliationRunStatus.COMPLETED;
      const finishedAt = new Date();
      const summary: RunSummary = { runId: run.id, status, trigger, startedAt: run.startedAt.toISOString(), finishedAt: finishedAt.toISOString(), ...result };
      await this.prisma.billingReconciliationRun.update({
        where: { id: run.id },
        data: { status, finishedAt, stats: this.statsFor(summary) as Prisma.InputJsonValue },
      });
      this.logger.log(JSON.stringify({ event: 'billing_reconciliation_run_finished', runId: run.id, scope: runScope, status, ...this.statsFor(summary) }));
      return summary;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await this.prisma.billingReconciliationRun.update({
        where: { id: run.id },
        data: { status: BillingReconciliationRunStatus.FAILED, finishedAt: new Date(), error: error.slice(0, 500) },
      });
      this.logger.error(JSON.stringify({ event: 'billing_reconciliation_run_failed', runId: run.id, scope: runScope, error: error.slice(0, 300) }));
      throw err;
    }
  }

  private statsFor(summary: RunSummary) {
    return {
      studios: summary.studios.length,
      issues: summary.studios.reduce((n, s) => n + s.issues, 0) + summary.platform.webhookIssues + summary.platform.refundIssues,
      created: summary.studios.reduce((n, s) => n + s.created, 0) + summary.platform.created,
      reopened: summary.studios.reduce((n, s) => n + s.reopened, 0) + summary.platform.reopened,
      autoResolved: summary.studios.reduce((n, s) => n + s.autoResolved, 0) + summary.platform.autoResolved,
      checkedMembers: summary.studios.reduce((n, s) => n + s.checkedMembers, 0),
      skippedMembers: summary.studios.reduce((n, s) => n + s.skippedMembers, 0),
      stripeCalls: summary.stripeCalls,
      stripeFailures: summary.studios.reduce((n, s) => n + s.stripeFailures, 0),
      incompleteStudios: summary.studios.filter((s) => s.error || s.incompleteCategories.length > 0).map((s) => s.studioId),
      alerts: summary.alerts,
      durationMs: new Date(summary.finishedAt).getTime() - new Date(summary.startedAt).getTime(),
    };
  }

  private async processStudio(runId: string, studioId: string, now: Date, opts: DetectOptions): Promise<StudioRunStats> {
    const stats: StudioRunStats = {
      studioId, issues: 0, created: 0, reopened: 0, updated: 0, autoResolved: 0, incompleteCategories: [],
      checkedMembers: 0, skippedMembers: 0, stripeCalls: 0, stripeFailures: 0, durationMs: 0, error: null,
    };
    try {
      const detection = await this.detectors.detectStudio(studioId, { ...opts, now });
      stats.issues = detection.issues.length;
      stats.checkedMembers = detection.checkedMembers;
      stats.skippedMembers = detection.skippedMembers;
      stats.stripeCalls = detection.stripeCalls;
      stats.stripeFailures = detection.stripeFailures;
      stats.durationMs = detection.durationMs;
      const observed = await this.observeAll(detection.issues, runId, now);
      stats.created = observed.created;
      stats.reopened = observed.reopened;
      stats.updated = observed.updated;
      const completeCategories = detection.coverage.filter((c) => c.complete).map((c) => c.category);
      stats.incompleteCategories = detection.coverage.filter((c) => !c.complete).map((c) => c.category);
      stats.autoResolved = await this.cases.resolveUnobserved(this.prisma, {
        studioId, categories: completeCategories, observedIssueKeys: observed.keys, runId, runStartedAt: now, now,
      });
    } catch (err) {
      stats.error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      this.logger.error(JSON.stringify({ event: 'billing_reconciliation_studio_failed', runId, studioId, error: stats.error }));
    }
    return stats;
  }

  private async processPlatform(runId: string, now: Date, scope: { studioId: string | null; webhooks: boolean; refunds: boolean }) {
    const out = { webhookIssues: 0, refundIssues: 0, created: 0, reopened: 0, autoResolved: 0, incomplete: false, stripeCalls: 0 };
    if (scope.webhooks) {
      const webhook = await this.detectors.detectWebhookProblems({ now });
      const issues = scope.studioId ? webhook.issues.filter((i) => i.studioId === scope.studioId) : webhook.issues;
      out.webhookIssues = issues.length;
      const observed = await this.observeAll(issues, runId, now);
      out.created += observed.created;
      out.reopened += observed.reopened;
      if (webhook.complete) {
        const studioScopes = scope.studioId ? [scope.studioId] : [null, ...new Set(issues.map((i) => i.studioId).filter((s): s is string => !!s))];
        for (const studioId of studioScopes) {
          out.autoResolved += await this.cases.resolveUnobserved(this.prisma, { studioId, categories: WEBHOOK_CATEGORIES, observedIssueKeys: observed.keys, runId, runStartedAt: now, now });
        }
        if (!scope.studioId) {
          // Studio-scoped webhook cases whose studio had no issue this run resolve too.
          const open = await this.prisma.billingReconciliationCase.findMany({ where: { category: { in: WEBHOOK_CATEGORIES }, status: { in: ['OPEN', 'ACKNOWLEDGED'] } }, select: { studioId: true }, distinct: ['studioId'] });
          for (const row of open) {
            if (row.studioId && !studioScopes.includes(row.studioId)) {
              out.autoResolved += await this.cases.resolveUnobserved(this.prisma, { studioId: row.studioId, categories: WEBHOOK_CATEGORIES, observedIssueKeys: observed.keys, runId, runStartedAt: now, now });
            }
          }
        }
      } else {
        out.incomplete = true;
      }
    }
    if (scope.refunds) {
      const refunds = await this.detectors.detectRefundsAndDisputes({ now, studioId: scope.studioId });
      out.refundIssues = refunds.issues.length;
      out.stripeCalls += refunds.stripeCalls;
      const observed = await this.observeAll(refunds.issues, runId, now);
      out.created += observed.created;
      out.reopened += observed.reopened;
      // Refund/dispute cases are window-bounded observations: never auto-resolved, operators close them.
      if (!refunds.complete) out.incomplete = true;
    }
    return out;
  }

  private async observeAll(issues: ObservedIssue[], runId: string, now: Date) {
    const result = { created: 0, reopened: 0, updated: 0, keys: new Set<string>() };
    // Two rules may name the same issue (e.g. a stale period seen from Stripe and from a payment):
    // one observation, carrying the most severe view.
    const byKey = new Map<string, ObservedIssue>();
    for (const issue of issues) {
      const key = buildIssueKey(issue.studioId, issue.category, issue.issueRef);
      const current = byKey.get(key);
      if (!current || SEVERITY_RANK[issue.severity] > SEVERITY_RANK[current.severity]) byKey.set(key, issue);
    }
    for (const [key, issue] of byKey) {
      result.keys.add(key);
      const { outcome } = await this.cases.observe(this.prisma, issue, { now, runId });
      if (outcome === 'created') result.created += 1;
      else if (outcome === 'reopened') result.reopened += 1;
      else if (outcome === 'updated') result.updated += 1;
    }
    return result;
  }
}
