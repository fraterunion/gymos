import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { BillingCaseCategory, BillingCaseSeverity, BillingCaseStatus, Role, type BillingReconciliationCase } from '@prisma/client';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { StudioMemberGuard } from '../../auth/guards/studio-member.guard';
import { BillingCaseService } from './billing-case.service';
import { categoryLabel, safeMemberReference, severityLabel, statusLabel, statusSentence } from './billing-case-copy';
import { BillingReconciliationRunService } from './billing-reconciliation-run.service';

export class CaseActionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ListCasesQueryDto {
  /** Comma-separated. Default: OPEN,ACKNOWLEDGED. */
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  severity?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @IsIn(['10', '20', '50', '100', '200'])
  limit?: string;
}

function csv<T extends string>(value: string | undefined, allowed: readonly T[]): T[] | undefined {
  if (!value) return undefined;
  const items = value.split(',').map((s) => s.trim()).filter((s): s is T => (allowed as readonly string[]).includes(s));
  return items.length ? items : undefined;
}

type CaseRow = BillingReconciliationCase & { user?: { firstName: string; lastName: string } | null };

/** Staff-facing shape: labels resolved server-side, member reduced to a safe reference. */
export function toCaseDto(row: CaseRow) {
  return {
    id: row.id,
    category: row.category,
    categoryLabel: categoryLabel(row.category),
    severity: row.severity,
    severityLabel: severityLabel(row.severity),
    status: row.status,
    statusLabel: statusLabel(row.status),
    statusSentence: statusSentence(row.status),
    reasonCode: row.reasonCode,
    title: row.title,
    summary: row.summary,
    suggestedAction: row.suggestedAction,
    member: row.userId ? { id: row.userId, reference: safeMemberReference(row.user?.firstName, row.user?.lastName) } : null,
    subscriptionId: row.subscriptionId,
    paymentId: row.paymentId,
    stripeSubscriptionId: row.stripeSubscriptionId,
    stripeInvoiceId: row.stripeInvoiceId,
    stripeEventId: row.stripeEventId,
    evidence: row.evidence,
    firstDetectedAt: row.firstDetectedAt.toISOString(),
    lastObservedAt: row.lastObservedAt.toISOString(),
    observationCount: row.observationCount,
    occurrenceCount: row.occurrenceCount,
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolutionNote: row.resolutionNote,
    dismissedAt: row.dismissedAt?.toISOString() ?? null,
    dismissReason: row.dismissReason,
    lastAlertedAt: row.lastAlertedAt?.toISOString() ?? null,
    alertCount: row.alertCount,
    history: row.history,
  };
}

@Controller('studios/:studioId/billing/reconciliation')
@UseGuards(JwtAuthGuard, StudioMemberGuard, RolesGuard)
export class BillingReconciliationController {
  constructor(
    private readonly cases: BillingCaseService,
    private readonly runs: BillingReconciliationRunService,
  ) {}

  @Get('cases')
  @Roles(Role.OWNER, Role.ADMIN, Role.STAFF)
  async list(@Param('studioId') studioId: string, @Query() query: ListCasesQueryDto) {
    const status = csv(query.status, Object.values(BillingCaseStatus)) ?? [BillingCaseStatus.OPEN, BillingCaseStatus.ACKNOWLEDGED];
    const result = await this.cases.listForStudio(studioId, {
      status,
      severity: csv(query.severity, Object.values(BillingCaseSeverity)),
      category: csv(query.category, Object.values(BillingCaseCategory)),
      userId: query.userId,
      cursor: query.cursor ?? null,
      limit: query.limit ? Number(query.limit) : 50,
    });
    return { items: result.items.map(toCaseDto), nextCursor: result.nextCursor, counts: result.counts };
  }

  @Get('cases/:caseId')
  @Roles(Role.OWNER, Role.ADMIN, Role.STAFF)
  async get(@Param('studioId') studioId: string, @Param('caseId') caseId: string) {
    return toCaseDto(await this.cases.getForStudio(studioId, caseId));
  }

  @Post('cases/:caseId/acknowledge')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.OWNER, Role.ADMIN)
  async acknowledge(@Param('studioId') studioId: string, @Param('caseId') caseId: string, @Body() dto: CaseActionDto, @CurrentUser('sub') actorUserId: string) {
    return toCaseDto(await this.cases.acknowledge(studioId, caseId, actorUserId, dto.note ?? null));
  }

  @Post('cases/:caseId/resolve')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.OWNER, Role.ADMIN)
  async resolve(@Param('studioId') studioId: string, @Param('caseId') caseId: string, @Body() dto: CaseActionDto, @CurrentUser('sub') actorUserId: string) {
    return toCaseDto(await this.cases.resolve(studioId, caseId, actorUserId, dto.note?.trim() || 'Resuelto por el staff.'));
  }

  @Post('cases/:caseId/dismiss')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.OWNER, Role.ADMIN)
  async dismiss(@Param('studioId') studioId: string, @Param('caseId') caseId: string, @Body() dto: CaseActionDto, @CurrentUser('sub') actorUserId: string) {
    return toCaseDto(await this.cases.dismiss(studioId, caseId, actorUserId, dto.note?.trim() || 'Descartado por el staff.'));
  }

  @Post('cases/:caseId/reopen')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.OWNER, Role.ADMIN)
  async reopen(@Param('studioId') studioId: string, @Param('caseId') caseId: string, @Body() dto: CaseActionDto, @CurrentUser('sub') actorUserId: string) {
    return toCaseDto(await this.cases.reopen(studioId, caseId, actorUserId, dto.note ?? null));
  }

  /** Detection-only run for this studio (GET-only against Stripe; writes cases, never memberships). */
  @Post('runs')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.OWNER, Role.ADMIN)
  async run(@Param('studioId') studioId: string) {
    return this.runs.runStudio(studioId, 'MANUAL', { deadlineMs: 120_000 });
  }

  @Get('runs/latest')
  @Roles(Role.OWNER, Role.ADMIN, Role.STAFF)
  async latest(@Param('studioId') studioId: string) {
    const run = await this.runs.latestRun(studioId);
    return run
      ? { ...run, startedAt: run.startedAt.toISOString(), finishedAt: run.finishedAt?.toISOString() ?? null }
      : null;
  }
}
