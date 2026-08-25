import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type StudioDayPassSettings } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../sales/audit.service';
import { toAuditMetadata } from '../sales/audit-metadata.utils';
import { StripeService } from '../stripe/stripe.service';
import {
  dayPassFinancialIdentityChanged,
  dayPassIntegrityFromMatch,
  dayPassProductIdempotencyKey,
  dayPassSalePriceIdempotencyKey,
  isStripeBackedDayPass,
  stripePriceMatchesDayPass,
  type DayPassFinancialIdentity,
  type DayPassIntegrityStatus,
} from './day-pass-stripe-price';
import type {
  DayPassCatalogResponseDto,
  DayPassSettingsResponseDto,
  ReconcileDayPassStripePriceResult,
} from './dto/day-pass-settings-response.dto';
import type { UpdateDayPassSettingsDto } from './dto/update-day-pass-settings.dto';

const VALIDITY_DESCRIPTION = 'Válido para un día calendario en la zona horaria del estudio.';

type EffectiveDayPassConfig = {
  configured: boolean;
  id: string | null;
  studioId: string;
  displayName: string;
  priceCents: number;
  currency: string;
  active: boolean;
  stripeProductId: string | null;
  stripePriceId: string | null;
  updatedAt: Date | null;
};

@Injectable()
export class DayPassSettingsService {
  private readonly logger = new Logger(DayPassSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  envDefaults(): DayPassFinancialIdentity & { displayName: string } {
    const priceCents = parseInt(this.config.get<string>('DAY_PASS_PRICE_CENTS', '20000'), 10);
    const currency = this.config.get<string>('DAY_PASS_CURRENCY', 'mxn').toLowerCase();
    return { displayName: 'Day Pass', priceCents, currency };
  }

  /** Read-only member/public catalog — never persists. */
  async getCatalog(studioId: string): Promise<DayPassCatalogResponseDto> {
    await this.assertStudioExists(studioId);
    const effective = await this.resolveEffectiveConfig(studioId);
    return {
      displayName: effective.displayName,
      priceCents: effective.priceCents,
      currency: effective.currency,
      active: effective.active,
      validityDescription: VALIDITY_DESCRIPTION,
    };
  }

  /** Read-only admin view — never persists. */
  async getSettings(studioId: string): Promise<DayPassSettingsResponseDto> {
    await this.assertStudioExists(studioId);
    const effective = await this.resolveEffectiveConfig(studioId);
    return this.mapEffectiveWithIntegrity(effective);
  }

  async updateSettings(
    studioId: string,
    dto: UpdateDayPassSettingsDto,
    actorUserId: string,
  ): Promise<DayPassSettingsResponseDto> {
    await this.assertStudioExists(studioId);

    let settings = await this.persistSettingsForStudio(studioId);

    const beforeIdentity: DayPassFinancialIdentity = {
      priceCents: settings.priceCents,
      currency: settings.currency,
    };
    const afterIdentity: DayPassFinancialIdentity = {
      priceCents: dto.priceCents ?? settings.priceCents,
      currency: settings.currency,
    };
    const financialChanged = dayPassFinancialIdentityChanged(beforeIdentity, afterIdentity);
    const needsStripeBootstrap = !isStripeBackedDayPass(settings) && (dto.active ?? settings.active);

    let rotated: {
      previousStripePriceId: string | null;
      newStripePriceId: string;
      stripeProductId: string;
    } | null = null;

    if (financialChanged || needsStripeBootstrap) {
      rotated = await this.rotateStripeSalePrice({
        settings,
        next: afterIdentity,
        displayName: dto.displayName ?? settings.displayName,
        source: 'day_pass_edit',
      });
    }

    const data: Prisma.StudioDayPassSettingsUpdateInput = {};
    if (dto.displayName !== undefined) data.displayName = dto.displayName;
    if (dto.priceCents !== undefined) data.priceCents = dto.priceCents;
    if (dto.active !== undefined) data.active = dto.active;
    if (rotated) {
      data.stripeProductId = rotated.stripeProductId;
      data.stripePriceId = rotated.newStripePriceId;
    }

    if (Object.keys(data).length === 0) {
      return this.mapPersistedWithIntegrity(settings);
    }

    try {
      settings = await this.prisma.studioDayPassSettings.update({
        where: { id: settings.id },
        data,
      });
    } catch (error) {
      this.logger.error(
        `Day Pass DB update failed after Stripe rotation settingsId=${settings.id}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }

    if (rotated?.previousStripePriceId) {
      await this.deactivatePreviousPrice(rotated.previousStripePriceId, settings.id);
    }

    await this.audit.log({
      studioId,
      actorUserId,
      action: 'DAY_PASS_UPDATED',
      entityType: 'studio_day_pass_settings',
      entityId: settings.id,
      metadata: toAuditMetadata({
        displayName: settings.displayName,
        active: settings.active,
        configured: true,
        ...(rotated
          ? {
              stripePriceRotated: financialChanged,
              previousStripePriceId: rotated.previousStripePriceId,
              newStripePriceId: rotated.newStripePriceId,
              oldPriceCents: beforeIdentity.priceCents,
              newPriceCents: afterIdentity.priceCents,
              oldCurrency: beforeIdentity.currency,
              newCurrency: afterIdentity.currency,
            }
          : {
              changes: Object.keys(data),
            }),
      }),
    });

    return this.mapPersistedWithIntegrity(settings);
  }

  async reconcileStripeSalePrice(
    studioId: string,
    actorUserId: string,
  ): Promise<ReconcileDayPassStripePriceResult> {
    await this.assertStudioExists(studioId);
    let settings = await this.persistSettingsForStudio(studioId);

    const identity: DayPassFinancialIdentity = {
      priceCents: settings.priceCents,
      currency: settings.currency,
    };

    if (settings.stripePriceId) {
      let linkedPrice;
      try {
        linkedPrice = await this.stripe.retrievePrice(settings.stripePriceId);
      } catch (error) {
        this.logger.error(
          `Stripe price retrieve failed during Day Pass reconcile settingsId=${settings.id}`,
          error instanceof Error ? error.stack : undefined,
        );
        throw new BadRequestException(
          'No pudimos verificar el precio en Stripe. No se realizaron cambios. Intenta nuevamente.',
        );
      }
      const match = stripePriceMatchesDayPass(linkedPrice, identity);
      if (match.ok) {
        return {
          status: 'already_synced',
          stripePriceId: settings.stripePriceId,
          settings: await this.mapPersistedWithIntegrity(settings),
        };
      }
    }

    const rotated = await this.rotateStripeSalePrice({
      settings,
      next: identity,
      displayName: settings.displayName,
      source: 'catalog_reconciliation',
    });

    settings = await this.applyRotatedCatalogPointer(settings, rotated);

    if (rotated.previousStripePriceId) {
      await this.deactivatePreviousPrice(rotated.previousStripePriceId, settings.id);
    }

    await this.audit.log({
      studioId,
      actorUserId,
      action: 'DAY_PASS_STRIPE_PRICE_RECONCILED',
      entityType: 'studio_day_pass_settings',
      entityId: settings.id,
      metadata: toAuditMetadata({
        source: 'catalog_reconciliation',
        displayName: settings.displayName,
        previousStripePriceId: rotated.previousStripePriceId,
        newStripePriceId: rotated.newStripePriceId,
        intendedPriceCents: identity.priceCents,
        currency: identity.currency,
        result: 'reconciled',
      }),
    });

    return {
      status: 'reconciled',
      previousStripePriceId: rotated.previousStripePriceId,
      newStripePriceId: rotated.newStripePriceId,
      settings: await this.mapPersistedWithIntegrity(settings),
    };
  }

  /**
   * Resolve canonical sale price for checkout.
   * May persist settings + Stripe catalog on first purchase (intentional bootstrap).
   */
  async resolveCheckoutSalePrice(
    studioId: string,
    actorUserId: string,
  ): Promise<{
    settings: StudioDayPassSettings;
    priceCents: number;
    currency: string;
    stripePriceId: string;
  }> {
    await this.assertStudioExists(studioId);
    const effective = await this.resolveEffectiveConfig(studioId);
    if (!effective.active) {
      throw new BadRequestException('Day Pass no está disponible en este momento.');
    }

    let settings = effective.configured
      ? await this.findPersistedSettings(studioId)
      : await this.persistSettingsForStudio(studioId);
    if (!settings) {
      throw new Error('Day Pass settings persistence failed unexpectedly');
    }

    const wasBootstrap = !effective.configured;
    if (!settings.stripePriceId) {
      const identity: DayPassFinancialIdentity = {
        priceCents: settings.priceCents,
        currency: settings.currency,
      };
      const rotated = await this.rotateStripeSalePrice({
        settings,
        next: identity,
        displayName: settings.displayName,
        source: 'checkout_bootstrap',
      });
      settings = await this.applyRotatedCatalogPointer(settings, rotated);

      await this.audit.log({
        studioId,
        actorUserId,
        action: wasBootstrap ? 'DAY_PASS_CHECKOUT_BOOTSTRAP' : 'DAY_PASS_STRIPE_PRICE_RECONCILED',
        entityType: 'studio_day_pass_settings',
        entityId: settings.id,
        metadata: toAuditMetadata({
          source: 'checkout_bootstrap',
          priceCents: settings.priceCents,
          currency: settings.currency,
          stripeProductId: settings.stripeProductId,
          stripePriceId: settings.stripePriceId,
        }),
      });
    }

    let stripePrice;
    try {
      stripePrice = await this.stripe.retrievePrice(settings.stripePriceId!);
    } catch (error) {
      this.logger.error(
        `Stripe price retrieve failed during Day Pass checkout settingsId=${settings.id}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new BadRequestException(
        'No pudimos verificar el precio del Day Pass. Inténtalo más tarde.',
      );
    }

    const identity: DayPassFinancialIdentity = {
      priceCents: settings.priceCents,
      currency: settings.currency,
    };
    const match = stripePriceMatchesDayPass(stripePrice, identity);
    if (!match.ok) {
      throw new BadRequestException(
        'El precio del Day Pass no está sincronizado con Stripe. Contacta al administrador.',
      );
    }

    return {
      settings,
      priceCents: stripePrice.unit_amount!,
      currency: stripePrice.currency,
      stripePriceId: stripePrice.id,
    };
  }

  private async resolveEffectiveConfig(studioId: string): Promise<EffectiveDayPassConfig> {
    const persisted = await this.findPersistedSettings(studioId);
    if (persisted) {
      return {
        configured: true,
        id: persisted.id,
        studioId: persisted.studioId,
        displayName: persisted.displayName,
        priceCents: persisted.priceCents,
        currency: persisted.currency,
        active: persisted.active,
        stripeProductId: persisted.stripeProductId,
        stripePriceId: persisted.stripePriceId,
        updatedAt: persisted.updatedAt,
      };
    }

    const defaults = this.envDefaults();
    return {
      configured: false,
      id: null,
      studioId,
      displayName: defaults.displayName,
      priceCents: defaults.priceCents,
      currency: defaults.currency,
      active: true,
      stripeProductId: null,
      stripePriceId: null,
      updatedAt: null,
    };
  }

  private async findPersistedSettings(studioId: string): Promise<StudioDayPassSettings | null> {
    return this.prisma.studioDayPassSettings.findUnique({ where: { studioId } });
  }

  /** Intentional persistence — used by PATCH, reconcile, and checkout bootstrap only. */
  private async persistSettingsForStudio(studioId: string): Promise<StudioDayPassSettings> {
    const existing = await this.findPersistedSettings(studioId);
    if (existing) return existing;

    const defaults = this.envDefaults();
    try {
      return await this.prisma.studioDayPassSettings.create({
        data: {
          studioId,
          displayName: defaults.displayName,
          priceCents: defaults.priceCents,
          currency: defaults.currency,
          active: true,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const raced = await this.findPersistedSettings(studioId);
        if (raced) return raced;
      }
      throw error;
    }
  }

  private async applyRotatedCatalogPointer(
    settings: StudioDayPassSettings,
    rotated: {
      previousStripePriceId: string | null;
      newStripePriceId: string;
      stripeProductId: string;
    },
  ): Promise<StudioDayPassSettings> {
    const where: Prisma.StudioDayPassSettingsWhereInput = rotated.previousStripePriceId
      ? { id: settings.id, stripePriceId: rotated.previousStripePriceId }
      : { id: settings.id, stripePriceId: null };

    const result = await this.prisma.studioDayPassSettings.updateMany({
      where,
      data: {
        stripeProductId: rotated.stripeProductId,
        stripePriceId: rotated.newStripePriceId,
      },
    });

    if (result.count === 0) {
      return this.prisma.studioDayPassSettings.findUniqueOrThrow({ where: { id: settings.id } });
    }

    return this.prisma.studioDayPassSettings.findUniqueOrThrow({ where: { id: settings.id } });
  }

  private async assertStudioExists(studioId: string): Promise<void> {
    const studio = await this.prisma.studio.findFirst({
      where: { id: studioId, deletedAt: null },
      select: { id: true },
    });
    if (!studio) {
      throw new NotFoundException('Studio not found');
    }
  }

  private async mapPersistedWithIntegrity(
    settings: StudioDayPassSettings,
  ): Promise<DayPassSettingsResponseDto> {
    return this.mapEffectiveWithIntegrity({
      configured: true,
      id: settings.id,
      studioId: settings.studioId,
      displayName: settings.displayName,
      priceCents: settings.priceCents,
      currency: settings.currency,
      active: settings.active,
      stripeProductId: settings.stripeProductId,
      stripePriceId: settings.stripePriceId,
      updatedAt: settings.updatedAt,
    });
  }

  private async mapEffectiveWithIntegrity(
    effective: EffectiveDayPassConfig,
  ): Promise<DayPassSettingsResponseDto> {
    const identity: DayPassFinancialIdentity = {
      priceCents: effective.priceCents,
      currency: effective.currency,
    };

    let status: DayPassIntegrityStatus = 'healthy';
    let stripeUnitAmount: number | null = null;
    let stripeCurrency: string | null = null;
    let stripePriceActive: boolean | null = null;
    let stripePriceType: 'one_time' | 'recurring' | null = null;

    if (!effective.stripePriceId) {
      status = 'missing_price';
    } else {
      try {
        const price = await this.stripe.retrievePrice(effective.stripePriceId);
        stripeUnitAmount = price.unit_amount;
        stripeCurrency = price.currency ?? null;
        stripePriceActive = price.active;
        stripePriceType = price.recurring ? 'recurring' : 'one_time';
        const match = stripePriceMatchesDayPass(price, identity);
        status = dayPassIntegrityFromMatch(match);
      } catch {
        status = 'fetch_error';
      }
    }

    return {
      configured: effective.configured,
      id: effective.id,
      studioId: effective.studioId,
      displayName: effective.displayName,
      priceCents: effective.priceCents,
      currency: effective.currency,
      active: effective.active,
      stripeProductId: effective.stripeProductId,
      stripePriceId: effective.stripePriceId,
      validityDescription: VALIDITY_DESCRIPTION,
      integrity: {
        status,
        stripeUnitAmount,
        stripeCurrency,
        stripePriceActive,
        stripePriceType,
      },
      updatedAt: effective.updatedAt?.toISOString() ?? null,
    };
  }

  private async rotateStripeSalePrice(params: {
    settings: StudioDayPassSettings;
    next: DayPassFinancialIdentity;
    displayName: string;
    source: 'day_pass_edit' | 'catalog_reconciliation' | 'checkout_bootstrap';
  }): Promise<{
    previousStripePriceId: string | null;
    newStripePriceId: string;
    stripeProductId: string;
  }> {
    const { settings, next, displayName, source } = params;
    let productId = settings.stripeProductId;

    try {
      if (!productId && settings.stripePriceId) {
        const existing = await this.stripe.retrievePrice(settings.stripePriceId);
        const product = existing.product;
        productId = typeof product === 'string' ? product : product?.id ?? null;
      }

      if (!productId) {
        const product = await this.stripe.createProductForPlan(
          {
            name: displayName,
            metadata: {
              gymosDayPassSettingsId: settings.id,
              gymosStudioId: settings.studioId,
            },
          },
          { idempotencyKey: dayPassProductIdempotencyKey(settings.studioId) },
        );
        productId = product.id;
      }

      const idempotencyKey = dayPassSalePriceIdempotencyKey(settings.id, next);
      const price = await this.stripe.createOneTimePrice(
        {
          productId,
          unitAmount: next.priceCents,
          currency: next.currency,
          metadata: {
            gymosDayPassSettingsId: settings.id,
            gymosStudioId: settings.studioId,
            previousStripePriceId: settings.stripePriceId ?? '',
            intendedPriceCents: String(next.priceCents),
            source,
          },
        },
        { idempotencyKey },
      );

      return {
        previousStripePriceId: settings.stripePriceId,
        newStripePriceId: price.id,
        stripeProductId: productId,
      };
    } catch (error) {
      this.logger.error(
        `Stripe Day Pass price rotation failed settingsId=${settings.id}; GymOS left unchanged`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new BadRequestException(
        'No pudimos actualizar el precio. No se realizaron cambios. Intenta nuevamente.',
      );
    }
  }

  private async deactivatePreviousPrice(priceId: string, settingsId: string): Promise<void> {
    try {
      await this.stripe.deactivatePrice(priceId);
    } catch (error) {
      this.logger.warn(
        `Failed to deactivate previous Day Pass Stripe Price ${priceId} for settings ${settingsId}: ${
          error instanceof Error ? error.message : 'unknown'
        }`,
      );
    }
  }
}
