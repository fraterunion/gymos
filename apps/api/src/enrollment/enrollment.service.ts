import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CampaignType, EnrollmentFeeStatus, Prisma, WaivedReason } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../stripe/stripe.service';
import type { CheckoutPreviewDto } from './dto/checkout-preview.dto';
import type { UpsertEnrollmentSettingsDto } from './dto/upsert-enrollment-settings.dto';

export type CheckoutQuote = CheckoutPreviewDto & {
  settingsId: string | null;
  isPromoCandidate: boolean;
};

@Injectable()
export class EnrollmentService {
  private readonly logger = new Logger(EnrollmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
  ) {}

  // ---------------------------------------------------------------------------
  // Quote — shared by preview endpoint and checkout session creation
  // ---------------------------------------------------------------------------

  async calculateCheckoutQuote(userId: string, studioId: string, planId: string): Promise<CheckoutQuote> {
    const [plan, settings, existingEnrollment] = await Promise.all([
      this.prisma.membershipPlan.findFirst({
        where: { id: planId, studioId, deletedAt: null, active: true },
      }),
      this.prisma.studioEnrollmentSettings.findUnique({ where: { studioId } }),
      this.prisma.memberEnrollment.findUnique({
        where: { studioId_userId: { studioId, userId } },
      }),
    ]);

    if (!plan) {
      throw new NotFoundException('Membership plan not found');
    }

    const noFee: CheckoutQuote = {
      planPriceCents:              plan.priceCents,
      currency:                    plan.currency,
      enrollmentFeeApplies:        false,
      enrollmentFeeCents:          0,
      promoLikelySlotsAvailable:   false,
      campaignName:                null,
      settingsId:                  null,
      isPromoCandidate:            false,
    };

    // No settings, settings inactive, or user already has a finalized enrollment
    if (
      !settings?.active ||
      existingEnrollment?.status === EnrollmentFeeStatus.PAID ||
      existingEnrollment?.status === EnrollmentFeeStatus.WAIVED
    ) {
      return noFee;
    }

    // Count only finalized WAIVED enrollments for promo eligibility
    const waivedCount =
      settings.campaignEnabled && settings.campaignType === CampaignType.FIRST_N_MEMBERS
        ? await this.prisma.memberEnrollment.count({
            where: { settingsId: settings.id, status: EnrollmentFeeStatus.WAIVED },
          })
        : 0;

    const promoLikelySlotsAvailable =
      settings.campaignEnabled &&
      settings.campaignType === CampaignType.FIRST_N_MEMBERS &&
      settings.campaignLimit !== null &&
      waivedCount < settings.campaignLimit &&
      settings.campaignDiscountPct === 100;

    return {
      planPriceCents:            plan.priceCents,
      currency:                  plan.currency,
      enrollmentFeeApplies:      true,
      enrollmentFeeCents:        settings.enrollmentFeeCents,
      promoLikelySlotsAvailable,
      campaignName:              settings.campaignName,
      settingsId:                settings.id,
      isPromoCandidate:          promoLikelySlotsAvailable,
    };
  }

  // ---------------------------------------------------------------------------
  // Stripe price — cache enrollment fee price on StudioEnrollmentSettings
  // ---------------------------------------------------------------------------

  async ensureEnrollmentFeeStripePrice(settingsId: string): Promise<string> {
    const settings = await this.prisma.studioEnrollmentSettings.findUniqueOrThrow({
      where: { id: settingsId },
    });

    if (settings.stripePriceId) {
      return settings.stripePriceId;
    }

    let productId = settings.stripeProductId;
    if (!productId) {
      const product = await this.stripe.createProductForPlan({
        name: `Enrollment Fee — ${settings.id}`,
        metadata: { gymosEnrollmentSettingsId: settings.id, gymosStudioId: settings.studioId },
      });
      productId = product.id;
    }

    const price = await this.stripe.createOneTimePrice({
      productId,
      unitAmount: settings.enrollmentFeeCents,
      currency: settings.currency,
    });

    await this.prisma.studioEnrollmentSettings.update({
      where: { id: settingsId },
      data: { stripeProductId: productId, stripePriceId: price.id },
    });

    return price.id;
  }

  // ---------------------------------------------------------------------------
  // Finalization — called from webhook after successful payment
  // ---------------------------------------------------------------------------

  async finalizeEnrollment(params: {
    userId: string;
    studioId: string;
    settingsId: string;
    stripeCheckoutSessionId: string;
    wasPromoCandidate: boolean;
  }): Promise<void> {
    const { userId, studioId, settingsId, stripeCheckoutSessionId, wasPromoCandidate } = params;

    try {
      await this.prisma.$transaction(
        async (tx) => {
          // Idempotency: skip if already finalized
          const existing = await tx.memberEnrollment.findUnique({
            where: { studioId_userId: { studioId, userId } },
          });
          if (
            existing?.status === EnrollmentFeeStatus.PAID ||
            existing?.status === EnrollmentFeeStatus.WAIVED
          ) {
            return;
          }

          const settings = await tx.studioEnrollmentSettings.findUniqueOrThrow({
            where: { id: settingsId },
          });

          // memberNumber: sequential across all PAID + WAIVED
          const totalFinalized = await tx.memberEnrollment.count({
            where: { settingsId, status: { in: [EnrollmentFeeStatus.PAID, EnrollmentFeeStatus.WAIVED] } },
          });
          const memberNumber = totalFinalized + 1;

          if (wasPromoCandidate) {
            // Re-evaluate slot availability inside the serializable transaction
            const waivedCount = await tx.memberEnrollment.count({
              where: { settingsId, status: EnrollmentFeeStatus.WAIVED },
            });
            const slotAvailable =
              settings.campaignLimit !== null && waivedCount < settings.campaignLimit;

            let founderNumber: number | null = null;
            let waivedReason: WaivedReason;

            if (slotAvailable) {
              // founderNumber: sequential within FIRST_N_PROMO waivers
              const founderCount = await tx.memberEnrollment.count({
                where: { settingsId, status: EnrollmentFeeStatus.WAIVED, waivedReason: WaivedReason.FIRST_N_PROMO },
              });
              founderNumber = founderCount + 1;
              waivedReason = WaivedReason.FIRST_N_PROMO;
            } else {
              // Race: slots ran out between checkout open and payment — honor the experience
              waivedReason = WaivedReason.FIRST_N_PROMO_OVERFLOW;
            }

            await tx.memberEnrollment.upsert({
              where: { studioId_userId: { studioId, userId } },
              create: {
                studioId,
                userId,
                settingsId,
                status: EnrollmentFeeStatus.WAIVED,
                waivedReason,
                memberNumber,
                founderNumber,
                stripeCheckoutSessionId,
                finalizedAt: new Date(),
              },
              update: {
                status: EnrollmentFeeStatus.WAIVED,
                waivedReason,
                memberNumber,
                founderNumber,
                stripeCheckoutSessionId,
                finalizedAt: new Date(),
              },
            });
          } else {
            await tx.memberEnrollment.upsert({
              where: { studioId_userId: { studioId, userId } },
              create: {
                studioId,
                userId,
                settingsId,
                status: EnrollmentFeeStatus.PAID,
                memberNumber,
                stripeCheckoutSessionId,
                finalizedAt: new Date(),
              },
              update: {
                status: EnrollmentFeeStatus.PAID,
                memberNumber,
                stripeCheckoutSessionId,
                finalizedAt: new Date(),
              },
            });
          }
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (err) {
      this.logger.error(
        `finalizeEnrollment failed for user ${userId} studio ${studioId} session ${stripeCheckoutSessionId}`,
        err,
      );
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Admin: enrollment settings CRUD
  // ---------------------------------------------------------------------------

  async getEnrollmentSettings(studioId: string) {
    const settings = await this.prisma.studioEnrollmentSettings.findUnique({
      where: { studioId },
    });
    if (!settings) return null;

    const [waivedCount, paidCount] = await Promise.all([
      this.prisma.memberEnrollment.count({ where: { settingsId: settings.id, status: EnrollmentFeeStatus.WAIVED } }),
      this.prisma.memberEnrollment.count({ where: { settingsId: settings.id, status: EnrollmentFeeStatus.PAID } }),
    ]);

    return { ...settings, waivedCount, paidCount };
  }

  async upsertEnrollmentSettings(studioId: string, dto: UpsertEnrollmentSettingsDto) {
    const settings = await this.prisma.studioEnrollmentSettings.upsert({
      where: { studioId },
      create: {
        studioId,
        enrollmentFeeCents: dto.enrollmentFeeCents,
        currency:           dto.currency ?? 'mxn',
        active:             dto.active,
        campaignEnabled:    dto.campaignEnabled,
        campaignType:       dto.campaignType ?? null,
        campaignName:       dto.campaignName ?? null,
        campaignLimit:      dto.campaignLimit ?? null,
        campaignDiscountPct: dto.campaignDiscountPct ?? null,
        campaignAppliesTo:  dto.campaignAppliesTo ?? null,
      },
      update: {
        enrollmentFeeCents: dto.enrollmentFeeCents,
        currency:           dto.currency ?? 'mxn',
        active:             dto.active,
        campaignEnabled:    dto.campaignEnabled,
        campaignType:       dto.campaignType ?? null,
        campaignName:       dto.campaignName ?? null,
        campaignLimit:      dto.campaignLimit ?? null,
        campaignDiscountPct: dto.campaignDiscountPct ?? null,
        campaignAppliesTo:  dto.campaignAppliesTo ?? null,
        // Reset cached Stripe price when fee amount changes
        stripePriceId:      null,
        stripeProductId:    null,
      },
    });
    const [waivedCount, paidCount] = await Promise.all([
      this.prisma.memberEnrollment.count({ where: { settingsId: settings.id, status: EnrollmentFeeStatus.WAIVED } }),
      this.prisma.memberEnrollment.count({ where: { settingsId: settings.id, status: EnrollmentFeeStatus.PAID } }),
    ]);
    return { ...settings, waivedCount, paidCount };
  }

  async listEnrollments(studioId: string, opts: { page?: number; limit?: number } = {}) {
    const page  = Math.max(1, opts.page  ?? 1);
    const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
    const skip  = (page - 1) * limit;

    const settings = await this.prisma.studioEnrollmentSettings.findUnique({ where: { studioId } });
    if (!settings) return { data: [], total: 0, page, limit };

    const [data, total] = await Promise.all([
      this.prisma.memberEnrollment.findMany({
        where:   { settingsId: settings.id },
        include: { user: { select: { id: true, email: true, firstName: true, lastName: true } } },
        orderBy: { finalizedAt: 'asc' },
        skip,
        take:    limit,
      }),
      this.prisma.memberEnrollment.count({ where: { settingsId: settings.id } }),
    ]);

    return { data, total, page, limit };
  }

  async adminWaiveEnrollment(studioId: string, enrollmentId: string) {
    const enrollment = await this.prisma.memberEnrollment.findUnique({ where: { id: enrollmentId } });
    if (!enrollment || enrollment.studioId !== studioId) {
      throw new NotFoundException('Enrollment not found');
    }
    return this.prisma.memberEnrollment.update({
      where: { id: enrollmentId },
      data:  { status: EnrollmentFeeStatus.WAIVED, waivedReason: WaivedReason.ADMIN_WAIVER },
    });
  }
}
