import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { BillingCaseSeverity, BillingCaseStatus, type BillingReconciliationCase } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EMAIL_PROVIDER, type EmailProvider } from '../../email/email-provider';
import { BillingCaseService } from './billing-case.service';
import { SEVERITY_RANK } from './billing-case.types';
import { categoryLabel, formatDateTimeEs, safeMemberReference, severityLabel } from './billing-case-copy';

/**
 * Actionable billing alerts. Disabled by default; every outbound channel is opt-in via env, and
 * nothing here can throw into a reconciliation run — provider failures are logged, recorded on
 * the case history and retried on the next run (no alert is marked sent unless a channel accepted it).
 *
 *   BILLING_ALERTS_ENABLED           'true' to send anything (default 'false' → log-only)
 *   BILLING_ALERT_WEBHOOK_URL        HTTPS endpoint receiving a JSON POST (Slack-compatible `text` field)
 *   BILLING_ALERT_EMAIL_TO           comma-separated recipients (uses the platform email provider)
 *   BILLING_ALERT_MIN_SEVERITY       CRITICAL | HIGH (default) | MEDIUM | LOW
 *   BILLING_ALERT_ESCALATION_HOURS   re-alert an unacknowledged CRITICAL/HIGH case after N hours (default 24)
 *   BILLING_ALERT_ADMIN_BASE_URL     base URL for deep links into the Admin (optional)
 */
export type BillingAlertSettings = {
  enabled: boolean;
  webhookUrl: string | null;
  emailTo: string[];
  minSeverity: BillingCaseSeverity;
  escalationHours: number;
  adminBaseUrl: string | null;
  fromAddress: string;
  fromName: string;
};

export type AlertDispatchSummary = { considered: number; sent: number; failed: number; suppressed: number; channels: string[] };

export type AlertMessage = { subject: string; text: string; html: string; payload: Record<string, unknown> };

@Injectable()
export class BillingAlertService {
  private readonly logger = new Logger(BillingAlertService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cases: BillingCaseService,
    @Optional() @Inject(EMAIL_PROVIDER) private readonly email?: EmailProvider,
  ) {}

  settings(): BillingAlertSettings {
    const env = process.env;
    const minSeverityRaw = (env['BILLING_ALERT_MIN_SEVERITY'] ?? 'HIGH').toUpperCase();
    const minSeverity = (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as BillingCaseSeverity[]).includes(minSeverityRaw as BillingCaseSeverity)
      ? (minSeverityRaw as BillingCaseSeverity)
      : BillingCaseSeverity.HIGH;
    const hours = Number(env['BILLING_ALERT_ESCALATION_HOURS'] ?? '24');
    return {
      enabled: env['BILLING_ALERTS_ENABLED'] === 'true',
      webhookUrl: validHttpsUrl(env['BILLING_ALERT_WEBHOOK_URL']),
      emailTo: (env['BILLING_ALERT_EMAIL_TO'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      minSeverity,
      escalationHours: Number.isFinite(hours) && hours > 0 ? hours : 24,
      adminBaseUrl: env['BILLING_ALERT_ADMIN_BASE_URL']?.trim().replace(/\/$/, '') || null,
      fromAddress: env['EMAIL_FROM_ADDRESS']?.trim() || 'no-reply@gymos.app',
      fromName: env['EMAIL_FROM_NAME']?.trim() || env['EMAIL_PLATFORM_NAME']?.trim() || 'GymOS',
    };
  }

  /** Cases that need a first alert or an escalation now. Idempotent: driven by lastAlertedAt. */
  async pendingAlerts(now: Date, studioId?: string | null): Promise<Array<{ case: BillingReconciliationCase; escalation: boolean }>> {
    const s = this.settings();
    const eligibleSeverities = (Object.keys(SEVERITY_RANK) as BillingCaseSeverity[]).filter((sev) => SEVERITY_RANK[sev] >= SEVERITY_RANK[s.minSeverity]);
    const rows = await this.prisma.billingReconciliationCase.findMany({
      where: {
        status: BillingCaseStatus.OPEN,
        severity: { in: eligibleSeverities },
        ...(studioId !== undefined ? { studioId } : {}),
      },
      orderBy: [{ severity: 'asc' }, { firstDetectedAt: 'asc' }],
      take: 100,
    });
    const escalationMs = s.escalationHours * 3_600_000;
    const out: Array<{ case: BillingReconciliationCase; escalation: boolean }> = [];
    for (const row of rows) {
      if (row.lastAlertedAt === null) {
        out.push({ case: row, escalation: false });
        continue;
      }
      const escalatable = row.severity === BillingCaseSeverity.CRITICAL || row.severity === BillingCaseSeverity.HIGH;
      if (escalatable && now.getTime() - row.lastAlertedAt.getTime() >= escalationMs) out.push({ case: row, escalation: true });
    }
    return out;
  }

  async dispatchPending(opts: { now?: Date; studioId?: string | null } = {}): Promise<AlertDispatchSummary> {
    const now = opts.now ?? new Date();
    const s = this.settings();
    const pending = await this.pendingAlerts(now, opts.studioId);
    const summary: AlertDispatchSummary = { considered: pending.length, sent: 0, failed: 0, suppressed: 0, channels: [] };
    if (pending.length === 0) return summary;

    if (!s.enabled) {
      // Log-only mode: structured, PII-free, one line per case — still useful for Railway log alerts.
      for (const p of pending) {
        this.logger.warn(JSON.stringify({ event: 'billing_alert_suppressed', reason: 'BILLING_ALERTS_ENABLED!=true', caseId: p.case.id, studioId: p.case.studioId, category: p.case.category, severity: p.case.severity, escalation: p.escalation }));
      }
      summary.suppressed = pending.length;
      return summary;
    }

    const channels: Array<{ name: string; send: (msg: AlertMessage) => Promise<void> }> = [];
    if (s.webhookUrl) channels.push({ name: 'webhook', send: (msg) => this.sendWebhook(s.webhookUrl!, msg) });
    if (s.emailTo.length > 0 && this.email) channels.push({ name: 'email', send: (msg) => this.sendEmail(s, msg) });
    summary.channels = channels.map((c) => c.name);
    if (channels.length === 0) {
      this.logger.warn(JSON.stringify({ event: 'billing_alerts_no_channel_configured', pending: pending.length }));
      summary.suppressed = pending.length;
      return summary;
    }

    const studioNames = new Map<string, string>();
    // Bounded fan-out per run: a backlog drains over several runs instead of hammering a provider.
    const batch = pending.slice(0, MAX_ALERTS_PER_RUN);
    summary.suppressed += pending.length - batch.length;
    for (const p of batch) {
      const msg = await this.buildMessage(p.case, p.escalation, s, studioNames);
      let anyOk = false;
      for (const channel of channels) {
        try {
          await channel.send(msg);
          anyOk = true;
          await this.cases.recordAlert(p.case.id, { channel: channel.name, ok: true, escalation: p.escalation, now });
          await this.auditAlert(p.case, channel.name, p.escalation, now);
        } catch (err) {
          // Never persist or log the provider's message: it can echo the webhook URL (with its
          // token) or recipient addresses. Only a sanitized class of failure is kept.
          const error = describeAlertError(err);
          this.logger.error(JSON.stringify({ event: 'billing_alert_delivery_failed', caseId: p.case.id, channel: channel.name, error }));
          await this.cases.recordAlert(p.case.id, { channel: channel.name, ok: false, escalation: p.escalation, error, now });
        }
      }
      if (anyOk) summary.sent += 1;
      else summary.failed += 1;
    }
    return summary;
  }

  async buildMessage(row: BillingReconciliationCase, escalation: boolean, s: BillingAlertSettings, studioNames: Map<string, string>): Promise<AlertMessage> {
    let studioName = 'Plataforma';
    if (row.studioId) {
      if (!studioNames.has(row.studioId)) {
        const studio = await this.prisma.studio.findUnique({ where: { id: row.studioId }, select: { name: true } });
        studioNames.set(row.studioId, studio?.name ?? row.studioId);
      }
      studioName = studioNames.get(row.studioId)!;
    }
    const member = row.userId ? await this.prisma.user.findUnique({ where: { id: row.userId }, select: { firstName: true, lastName: true } }) : null;
    const memberRef = member ? `${safeMemberReference(member.firstName, member.lastName)} (${row.userId})` : null;
    const link = s.adminBaseUrl && row.studioId
      ? row.userId
        ? `${s.adminBaseUrl}/members/${row.userId}?tab=billing`
        : `${s.adminBaseUrl}/billing/exceptions?case=${row.id}`
      : null;
    const prefix = escalation ? '[ESCALACIÓN] ' : '';
    const subject = `${prefix}[${severityLabel(row.severity)}] ${categoryLabel(row.category)} · ${studioName}`;
    const lines = [
      `${prefix}${row.title}`,
      `Estudio: ${studioName}`,
      `Categoría: ${categoryLabel(row.category)} · Severidad: ${severityLabel(row.severity)}`,
      `Detectado: ${formatDateTimeEs(row.firstDetectedAt)}${escalation ? ` · sin revisar desde entonces` : ''}`,
      memberRef ? `Miembro: ${memberRef}` : null,
      `Impacto: ${row.summary}`,
      `Acción recomendada: ${row.suggestedAction}`,
      link ? `Ver en Admin: ${link}` : null,
      `Caso: ${row.id}`,
    ].filter((l): l is string => !!l);
    const text = lines.join('\n');
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">${lines.map((l) => `<p style="margin:0 0 8px">${escapeHtml(l)}</p>`).join('')}</div>`;
    return {
      subject,
      text,
      html,
      payload: {
        text,
        gymos: {
          caseId: row.id,
          studioId: row.studioId,
          studioName,
          category: row.category,
          severity: row.severity,
          reasonCode: row.reasonCode,
          firstDetectedAt: row.firstDetectedAt.toISOString(),
          lastObservedAt: row.lastObservedAt.toISOString(),
          escalation,
          memberRef,
          title: row.title,
          summary: row.summary,
          suggestedAction: row.suggestedAction,
          link,
        },
      },
    };
  }

  private async sendWebhook(url: string, msg: AlertMessage): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(msg.payload),
        signal: controller.signal,
      });
      if (!res.ok) throw new AlertDeliveryError(`http_${res.status}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async sendEmail(s: BillingAlertSettings, msg: AlertMessage): Promise<void> {
    if (!this.email) throw new AlertDeliveryError('email_provider_unavailable');
    let delivered = 0;
    let failed = 0;
    for (const to of s.emailTo) {
      try {
        const result = await this.email.send({
          to,
          from: { email: s.fromAddress, name: s.fromName },
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
          tags: { category: 'billing-alert' },
        });
        if (result.delivered) delivered += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }
    if (delivered === 0) throw new AlertDeliveryError(failed > 0 ? `email_failed_${failed}_recipients` : 'email_no_recipients');
  }

  private async auditAlert(row: BillingReconciliationCase, channel: string, escalation: boolean, now: Date): Promise<void> {
    if (!row.studioId) return;
    try {
      await this.prisma.auditLog.create({
        data: {
          studioId: row.studioId,
          actorUserId: null,
          action: 'BILLING_ALERT_SENT',
          targetUserId: null,
          entityType: 'BillingReconciliationCase',
          entityId: row.id,
          metadata: { channel, escalation, severity: row.severity, category: row.category, at: now.toISOString() },
        },
      });
    } catch (err) {
      this.logger.warn(JSON.stringify({ event: 'billing_alert_audit_write_failed', caseId: row.id, error: (err instanceof Error ? err.message : String(err)).slice(0, 200) }));
    }
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const MAX_ALERTS_PER_RUN = 25;
const WEBHOOK_TIMEOUT_MS = 5_000;

/** Only an absolute https URL is accepted; anything else disables the channel (and is logged once per settings read). */
function validHttpsUrl(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

class AlertDeliveryError extends Error {
  constructor(public readonly kind: string) {
    super(kind);
    this.name = 'AlertDeliveryError';
  }
}

/** A short, secret-free classification of a delivery failure (never the provider's message). */
function describeAlertError(err: unknown): string {
  if (err instanceof AlertDeliveryError) return err.kind;
  if (err instanceof Error) {
    if (err.name === 'AbortError') return 'timeout';
    if (err.name === 'TypeError') return 'network_or_url_error';
    return err.name || 'error';
  }
  return 'error';
}
