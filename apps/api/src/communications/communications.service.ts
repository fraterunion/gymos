import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EmailCampaignStatus,
  EmailRecipientStatus,
  EmailSuppressionReason,
  Prisma,
  Role,
  type EmailCampaign,
} from '@prisma/client';
import { EMAIL_PROVIDER, type EmailProvider } from '../email/email-provider';
import { resolveEmailBranding, type PlatformEmailDefaults } from '../email/email-branding';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../sales/audit.service';
import { normalizeCampaignContent, renderCampaignEmail } from './campaign-email.template';
import { campaignAudienceSignature, recipientSnapshotFingerprint, resolveCampaignRecipients, type CampaignFilters, type RecipientCandidate } from './campaign-recipients';
import type { ConfirmCampaignDto, CreateCampaignDto, PreviewCampaignDto } from './dto/campaign.dto';
import { readUnsubscribeToken, signUnsubscribeToken } from './unsubscribe-token';

const STALE_CLAIM_MS = 10 * 60_000;
const DEFAULT_BATCH = 5;

@Injectable()
export class CommunicationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CommunicationsService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
  ) {}

  onModuleInit() {
    if (process.env['GYMOS_E2E'] === '1' || process.env['EMAIL_CAMPAIGN_WORKER'] === '0') return;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.logger.error('Campaign delivery tick failed', error instanceof Error ? error.stack : undefined);
      });
    }, 2_000);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async preview(studioId: string, dto: PreviewCampaignDto) {
    this.assertAudience(dto);
    const resolved = await this.resolve(studioId, dto);
    return {
      recipientCount: resolved.recipients.length,
      previewFingerprint: recipientSnapshotFingerprint(resolved.recipients),
      suppressedCount: resolved.suppressed.length,
      invalidEmails: resolved.invalidEmails,
      recipients: resolved.recipients,
      suppressed: resolved.suppressed,
    };
  }

  async create(studioId: string, actorUserId: string, dto: CreateCampaignDto) {
    this.assertAudience(dto);
    const content = this.parseContent(dto.subject, dto.bodyText);
    const existing = await this.prisma.emailCampaign.findUnique({
      where: { studioId_idempotencyKey: { studioId, idempotencyKey: dto.idempotencyKey } },
    });
    if (existing) {
      if (
        existing.subject !== content.subject ||
        existing.bodyText !== content.bodyText ||
        campaignAudienceSignature({
          filters: existing.filters as CampaignFilters,
          includeUserIds: existing.includeUserIds,
          excludeUserIds: existing.excludeUserIds,
          allMembers: existing.allMembers,
        }) !== campaignAudienceSignature(dto)
      ) {
        throw new ConflictException(
          'Esta clave de idempotencia ya se usó para otra campaña o selección de destinatarios.',
        );
      }
      if (dto.previewFingerprint) {
        const recorded = await this.prisma.emailCampaignRecipient.findMany({
          where: { campaignId: existing.id },
          select: { userId: true, email: true },
        });
        if (recipientSnapshotFingerprint(recorded) !== dto.previewFingerprint) {
          throw new ConflictException(
            'Esta campaña ya tiene otros destinatarios confirmados. Genera una nueva campaña y vista previa.',
          );
        }
      }
      return this.campaignView(existing.id);
    }
    const resolved = await this.resolve(studioId, dto);
    // A preview authorizes a particular set of destination addresses, not an
    // arbitrary later result of the same filters. Any membership/consent change
    // between preview and creation must force a fresh review before sending.
    if (dto.previewFingerprint && recipientSnapshotFingerprint(resolved.recipients) !== dto.previewFingerprint) {
      throw new ConflictException('Los destinatarios cambiaron desde la vista previa. Actualiza la vista previa antes de enviar.');
    }
    if (resolved.recipients.length === 0) {
      throw new BadRequestException('No hay destinatarios con los filtros seleccionados.');
    }
    const campaign = await this.prisma.emailCampaign.create({
      data: {
        studioId,
        createdById: actorUserId,
        subject: content.subject,
        bodyText: content.bodyText,
        status: EmailCampaignStatus.DRAFT,
        filters: (dto.filters ?? {}) as Prisma.InputJsonValue,
        includeUserIds: dto.includeUserIds ?? [],
        excludeUserIds: dto.excludeUserIds ?? [],
        allMembers: dto.allMembers === true,
        idempotencyKey: dto.idempotencyKey,
        recipientCount: resolved.recipients.length,
        recipients: {
          create: resolved.recipients.map((recipient) => ({
            studioId,
            userId: recipient.userId,
            email: recipient.email,
            status: EmailRecipientStatus.PENDING,
          })),
        },
      },
    });
    await this.audit.log({
      studioId,
      actorUserId,
      action: 'EMAIL_CAMPAIGN_CREATED',
      entityType: 'email_campaign',
      entityId: campaign.id,
      metadata: {
        subject: campaign.subject,
        recipientCount: campaign.recipientCount,
        allMembers: campaign.allMembers,
        filters: (dto.filters ?? {}) as Prisma.InputJsonValue,
      },
    });
    return this.campaignView(campaign.id);
  }

  async confirm(studioId: string, campaignId: string, actorUserId: string, dto: ConfirmCampaignDto) {
    if (dto.confirm !== true) {
      throw new BadRequestException('Confirma el envío antes de despachar la campaña.');
    }
    const campaign = await this.requireCampaign(studioId, campaignId);
    if (campaign.status !== EmailCampaignStatus.DRAFT) {
      return this.campaignView(campaign.id);
    }
    // Fail closed before enabling delivery. Every marketing email MUST contain
    // a working public unsubscribe URL; never ship localhost links.
    this.unsubscribeBase();
    const now = new Date();
    await this.prisma.emailCampaign.update({
      where: { id: campaign.id },
      data: { status: EmailCampaignStatus.SENDING, confirmedAt: now, startedAt: now },
    });
    await this.audit.log({
      studioId,
      actorUserId,
      action: 'EMAIL_CAMPAIGN_CONFIRMED',
      entityType: 'email_campaign',
      entityId: campaign.id,
      metadata: { recipientCount: campaign.recipientCount },
    });
    return this.campaignView(campaign.id);
  }

  async retryFailed(studioId: string, campaignId: string, actorUserId: string, confirm: boolean) {
    if (confirm !== true) throw new BadRequestException('Confirma el reintento antes de reenviar.');
    const campaign = await this.requireCampaign(studioId, campaignId);
    if (campaign.status === EmailCampaignStatus.DRAFT) {
      throw new BadRequestException('La campaña todavía no fue confirmada.');
    }
    await this.prisma.emailCampaignRecipient.updateMany({
      where: { campaignId, status: { in: [EmailRecipientStatus.FAILED, EmailRecipientStatus.SKIPPED] } },
      data: { status: EmailRecipientStatus.PENDING, error: null, claimedAt: null },
    });
    await this.prisma.emailCampaign.update({
      where: { id: campaignId },
      data: { status: EmailCampaignStatus.SENDING, completedAt: null },
    });
    await this.audit.log({
      studioId,
      actorUserId,
      action: 'EMAIL_CAMPAIGN_RETRIED',
      entityType: 'email_campaign',
      entityId: campaignId,
      metadata: {},
    });
    return this.campaignView(campaignId);
  }

  async list(studioId: string) {
    const rows = await this.prisma.emailCampaign.findMany({
      where: { studioId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((row) => this.summary(row));
  }

  async getOne(studioId: string, campaignId: string) {
    await this.requireCampaign(studioId, campaignId);
    return this.campaignView(campaignId);
  }

  /**
   * GET must only validate and display a confirmation page: mailbox scanners
   * routinely GET every link, and must never silently unsubscribe a member.
   * Actual suppression is POST only (including RFC 8058 one-click mail clients).
   */
  validateUnsubscribeToken(token: string) {
    const secret = this.config.getOrThrow<string>('JWT_SECRET');
    const payload = readUnsubscribeToken(token, secret);
    if (!payload) throw new BadRequestException('El enlace para cancelar la suscripción no es válido.');
    return payload;
  }

  async unsubscribe(token: string) {
    const payload = this.validateUnsubscribeToken(token);
    await this.prisma.emailSuppression.upsert({
      where: { studioId_email: { studioId: payload.studioId, email: payload.email } },
      create: { studioId: payload.studioId, email: payload.email, reason: EmailSuppressionReason.UNSUBSCRIBE },
      update: { reason: EmailSuppressionReason.UNSUBSCRIBE },
    });
    return { ok: true };
  }

  /** Sends pending recipients. Tests call this directly; production uses the interval. */
  async deliver(campaignId: string, opts?: { maxSends?: number }) {
    await this.reclaimStaleClaims(campaignId);
    let sentThisCall = 0;
    const max = opts?.maxSends ?? Number.POSITIVE_INFINITY;
    while (sentThisCall < max) {
      const row = await this.prisma.emailCampaignRecipient.findFirst({
        where: { campaignId, status: EmailRecipientStatus.PENDING },
        orderBy: { createdAt: 'asc' },
      });
      if (!row) break;
      const claimed = await this.prisma.emailCampaignRecipient.updateMany({
        where: { id: row.id, status: EmailRecipientStatus.PENDING },
        data: { status: EmailRecipientStatus.SENDING, claimedAt: new Date() },
      });
      if (claimed.count !== 1) continue;
      await this.sendOne(row.id);
      sentThisCall += 1;
      const delay = Number(process.env['EMAIL_CAMPAIGN_SEND_DELAY_MS'] ?? 200);
      if (delay > 0 && sentThisCall < max) await new Promise((resolve) => setTimeout(resolve, delay));
    }
    await this.refreshCounts(campaignId);
  }

  private async tick() {
    const campaign = await this.prisma.emailCampaign.findFirst({
      where: { status: EmailCampaignStatus.SENDING },
      orderBy: { confirmedAt: 'asc' },
      select: { id: true },
    });
    if (!campaign) return;
    await this.deliver(campaign.id, { maxSends: DEFAULT_BATCH });
  }

  private async sendOne(recipientId: string) {
    const recipient = await this.prisma.emailCampaignRecipient.findUnique({
      where: { id: recipientId },
      include: { campaign: true, user: { select: { firstName: true } } },
    });
    if (!recipient || recipient.campaign.status !== EmailCampaignStatus.SENDING) return;
    const suppressed = await this.prisma.emailSuppression.findUnique({
      where: { studioId_email: { studioId: recipient.studioId, email: recipient.email } },
    });
    if (suppressed) {
      await this.prisma.emailCampaignRecipient.update({
        where: { id: recipient.id },
        data: { status: EmailRecipientStatus.SUPPRESSED, error: suppressed.reason, claimedAt: null },
      });
      return;
    }
    try {
      const studio = await this.prisma.studio.findFirst({
        where: { id: recipient.studioId, deletedAt: null },
        select: {
          id: true, slug: true, name: true, appName: true, appDisplayName: true,
          brandPrimaryColor: true, primaryColor: true, brandLogoUrl: true, logoUrl: true,
          supportEmail: true, supportPhone: true,
        },
      });
      const branding = resolveEmailBranding(studio, this.platformDefaults());
      const token = signUnsubscribeToken(
        { studioId: recipient.studioId, email: recipient.email },
        this.config.getOrThrow<string>('JWT_SECRET'),
      );
      const unsubscribeUrl = `${this.unsubscribeBase()}/api/v1/email/unsubscribe?token=${encodeURIComponent(token)}`;
      const rendered = renderCampaignEmail({
        studioName: branding.displayName,
        subject: recipient.campaign.subject,
        bodyText: recipient.campaign.bodyText,
        unsubscribeUrl,
      });
      const result = await this.email.send({
        to: recipient.email,
        from: branding.from,
        replyTo: branding.supportEmail ?? undefined,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        idempotencyKey: `campaign-recipient:${recipient.id}`,
        headers: {
          'List-Unsubscribe': `<${unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
        tags: { type: 'campaign', campaign: recipient.campaignId },
      });
      if (!result.delivered) {
        await this.prisma.emailCampaignRecipient.update({
          where: { id: recipient.id },
          data: { status: EmailRecipientStatus.SKIPPED, error: 'provider_did_not_deliver', claimedAt: null },
        });
        return;
      }
      await this.prisma.emailCampaignRecipient.update({
        where: { id: recipient.id },
        data: {
          status: EmailRecipientStatus.SENT,
          providerMessageId: result.providerMessageId,
          sentAt: new Date(),
          error: null,
          claimedAt: null,
        },
      });
    } catch (error) {
      await this.prisma.emailCampaignRecipient.update({
        where: { id: recipient.id },
        data: {
          status: EmailRecipientStatus.FAILED,
          error: (error instanceof Error ? error.message : 'send failed').slice(0, 500),
          claimedAt: null,
        },
      });
    }
  }

  private async refreshCounts(campaignId: string) {
    const grouped = await this.prisma.emailCampaignRecipient.groupBy({
      by: ['status'],
      where: { campaignId },
      _count: { _all: true },
    });
    const count = (status: EmailRecipientStatus) => grouped.find((row) => row.status === status)?._count._all ?? 0;
    const pending = count(EmailRecipientStatus.PENDING) + count(EmailRecipientStatus.SENDING);
    const sent = count(EmailRecipientStatus.SENT);
    const failed = count(EmailRecipientStatus.FAILED);
    const skipped = count(EmailRecipientStatus.SKIPPED) + count(EmailRecipientStatus.SUPPRESSED);
    const status = pending > 0
      ? EmailCampaignStatus.SENDING
      : failed > 0 && sent === 0
        ? EmailCampaignStatus.FAILED
        : failed > 0
          ? EmailCampaignStatus.PARTIAL
          : EmailCampaignStatus.COMPLETED;
    await this.prisma.emailCampaign.update({
      where: { id: campaignId },
      data: {
        sentCount: sent,
        failedCount: failed,
        skippedCount: skipped,
        status,
        completedAt: pending > 0 ? null : new Date(),
      },
    });
  }

  private async reclaimStaleClaims(campaignId: string) {
    await this.prisma.emailCampaignRecipient.updateMany({
      where: {
        campaignId,
        status: EmailRecipientStatus.SENDING,
        claimedAt: { lt: new Date(Date.now() - STALE_CLAIM_MS) },
      },
      data: { status: EmailRecipientStatus.PENDING, claimedAt: null },
    });
  }

  private async resolve(studioId: string, dto: PreviewCampaignDto) {
    const memberships = await this.prisma.studioMembership.findMany({
      where: { studioId, deletedAt: null, role: Role.MEMBER, user: { deletedAt: null } },
      select: {
        user: { select: { id: true, email: true, firstName: true, lastName: true } },
      },
    });
    const userIds = memberships.map((row) => row.user.id);
    const subscriptions = userIds.length
      ? await this.prisma.subscription.findMany({
          where: { studioId, userId: { in: userIds } },
          select: {
            userId: true,
            membershipPlanId: true,
            source: true,
            status: true,
            currentPeriodStart: true,
            currentPeriodEnd: true,
            entitlementEndsAt: true,
            cancelAtPeriodEnd: true,
            membershipPlan: { select: { name: true } },
          },
        })
      : [];
    const byUser = new Map<string, RecipientCandidate>();
    for (const membership of memberships) {
      byUser.set(membership.user.id, {
        userId: membership.user.id,
        email: membership.user.email,
        firstName: membership.user.firstName,
        lastName: membership.user.lastName,
        subscriptions: [],
      });
    }
    for (const subscription of subscriptions) {
      const candidate = byUser.get(subscription.userId);
      if (!candidate) continue;
      candidate.subscriptions.push({
        membershipPlanId: subscription.membershipPlanId,
        planName: subscription.membershipPlan.name,
        source: subscription.source,
        status: subscription.status,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        entitlementEndsAt: subscription.entitlementEndsAt,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      });
    }
    const suppressedRows = await this.prisma.emailSuppression.findMany({
      where: { studioId },
      select: { email: true },
    });
    return resolveCampaignRecipients({
      members: [...byUser.values()],
      filters: (dto.filters ?? {}) as CampaignFilters,
      includeUserIds: dto.includeUserIds ?? [],
      excludeUserIds: dto.excludeUserIds ?? [],
      allMembers: dto.allMembers === true,
      suppressedEmails: new Set(suppressedRows.map((row) => row.email.toLowerCase())),
      now: new Date(),
    });
  }

  private assertAudience(dto: PreviewCampaignDto) {
    const filters = dto.filters;
    const narrowing = Boolean(filters?.planIds?.length || filters?.statuses?.length || filters?.paymentSources?.length);
    if (!dto.allMembers && !narrowing && !(dto.includeUserIds?.length)) {
      throw new BadRequestException('Elige filtros, miembros específicos, o confirma el envío a todos los miembros.');
    }
  }

  private parseContent(subject: string, bodyText: string) {
    try {
      return normalizeCampaignContent(subject, bodyText);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Mensaje inválido');
    }
  }

  private async requireCampaign(studioId: string, campaignId: string): Promise<EmailCampaign> {
    const campaign = await this.prisma.emailCampaign.findFirst({ where: { id: campaignId, studioId } });
    if (!campaign) throw new NotFoundException('Campaign not found');
    return campaign;
  }

  private async campaignView(campaignId: string) {
    const campaign = await this.prisma.emailCampaign.findUniqueOrThrow({
      where: { id: campaignId },
      include: {
        recipients: {
          orderBy: { email: 'asc' },
          include: { user: { select: { firstName: true, lastName: true } } },
        },
      },
    });
    return {
      ...this.summary(campaign),
      bodyText: campaign.bodyText,
      filters: campaign.filters,
      recipients: campaign.recipients.map((recipient) => ({
        id: recipient.id,
        userId: recipient.userId,
        name: `${recipient.user.firstName} ${recipient.user.lastName}`.trim(),
        email: recipient.email,
        status: recipient.status,
        error: recipient.error,
        sentAt: recipient.sentAt,
        providerMessageId: recipient.providerMessageId,
      })),
    };
  }

  private summary(campaign: EmailCampaign) {
    return {
      id: campaign.id,
      subject: campaign.subject,
      status: campaign.status,
      allMembers: campaign.allMembers,
      recipientCount: campaign.recipientCount,
      sentCount: campaign.sentCount,
      failedCount: campaign.failedCount,
      skippedCount: campaign.skippedCount,
      confirmedAt: campaign.confirmedAt,
      completedAt: campaign.completedAt,
      createdAt: campaign.createdAt,
    };
  }

  private platformDefaults(): PlatformEmailDefaults {
    return {
      platformName: this.config.get<string>('EMAIL_PLATFORM_NAME', 'GymOS'),
      fromEmail: this.config.get<string>('EMAIL_FROM_ADDRESS', 'no-reply@gymos.app'),
      fromName: this.config.get<string>('EMAIL_FROM_NAME', '') || null,
      supportEmail: this.config.get<string>('EMAIL_SUPPORT_ADDRESS', '') || null,
      resetUrlBase: this.config.get<string>('PASSWORD_RESET_URL_BASE', '') || 'http://localhost:3000',
    };
  }

  private unsubscribeBase(): string {
    const configured = (this.config.get<string>('EMAIL_UNSUBSCRIBE_URL_BASE', '') ?? '').trim()
      || (this.config.get<string>('EXPO_PUBLIC_API_URL', '') ?? '').trim();
    if (!configured) {
      throw new BadRequestException(
        'Configura EMAIL_UNSUBSCRIBE_URL_BASE con el dominio HTTPS público de la API antes de enviar campañas.',
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(configured);
    } catch {
      throw new BadRequestException('La URL pública para cancelar correos no es válida.');
    }
    if (
      parsed.protocol !== 'https:' ||
      ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
      (parsed.pathname !== '/' && parsed.pathname !== '') ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      throw new BadRequestException(
        'EMAIL_UNSUBSCRIBE_URL_BASE debe ser el origen HTTPS público de la API, sin /api/v1 ni parámetros.',
      );
    }
    return parsed.origin;
  }
}
