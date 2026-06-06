import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DayPassStatus, Prisma } from '@prisma/client';
import { getStudioLocalDateKey, studioLocalDateKeyToUtcAnchor } from '../common/date/studio-local-date';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../stripe/stripe.service';
import type { DayPassResponseDto } from './dto/day-pass-response.dto';

// Must match the Stripe SDK version used by the mobile React Native client.
// Update this if the mobile Stripe SDK is upgraded.
const STRIPE_MOBILE_API_VERSION = '2025-08-27.basil';

export type DayPassPaymentSheetResponse = {
  dayPassId: string;
  paymentIntentClientSecret: string;
  customerId: string;
  ephemeralKeySecret: string;
  publishableKey: string;
};

@Injectable()
export class DayPassesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly config: ConfigService,
  ) {}

  async listMyDayPasses(studioId: string, userId: string): Promise<DayPassResponseDto[]> {
    return this.prisma.dayPass.findMany({
      where: {
        studioId,
        userId,
        status: { in: [DayPassStatus.PENDING, DayPassStatus.ACTIVE] },
      },
      select: {
        id: true,
        validForDate: true,
        status: true,
        priceCents: true,
        currency: true,
        createdAt: true,
      },
      orderBy: { validForDate: 'desc' },
    });
  }

  async createDayPassPaymentSheet(params: {
    studioId: string;
    userId: string;
    validForDate: string;
  }): Promise<DayPassPaymentSheetResponse> {
    const { studioId, userId, validForDate } = params;

    const studio = await this.prisma.studio.findFirst({
      where: { id: studioId, deletedAt: null },
      select: { id: true, timezone: true },
    });
    if (!studio) {
      throw new NotFoundException('Studio not found');
    }

    const todayKey = getStudioLocalDateKey(new Date(), studio.timezone);
    if (validForDate < todayKey) {
      throw new BadRequestException(
        'validForDate must be today or a future date in the studio timezone',
      );
    }

    const validForDateUtc = studioLocalDateKeyToUtcAnchor(validForDate, studio.timezone);

    const existing = await this.prisma.dayPass.findFirst({
      where: {
        studioId,
        userId,
        validForDate: validForDateUtc,
        status: { in: [DayPassStatus.ACTIVE, DayPassStatus.PENDING] },
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException('A Day Pass already exists for this date');
    }

    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true, email: true, firstName: true, lastName: true, stripeCustomerId: true },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const customer = await this.stripe.createOrRetrieveCustomer({
      email: user.email,
      name: `${user.firstName} ${user.lastName}`.trim(),
      existingStripeCustomerId: user.stripeCustomerId,
      metadata: { gymosUserId: user.id },
    });
    if (customer.id !== user.stripeCustomerId) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { stripeCustomerId: customer.id },
      });
    }

    let dayPassId: string;
    try {
      const dayPass = await this.prisma.dayPass.create({
        data: {
          studioId,
          userId,
          validForDate: validForDateUtc,
          priceCents: 20000,
          currency: 'mxn',
          status: DayPassStatus.PENDING,
        },
        select: { id: true },
      });
      dayPassId = dayPass.id;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('A Day Pass already exists for this date');
      }
      throw err;
    }

    // Track whether the paymentIntentId was persisted to the DB so the
    // rollback condition can be exact — see rollbackNewPendingDayPass.
    let paymentIntentId: string | null = null;
    let paymentIntentSavedToDb = false;

    try {
      const paymentIntent = await this.stripe.createPaymentIntent({
        amount: 20000,
        currency: 'mxn',
        customer: customer.id,
        metadata: {
          type: 'day_pass',
          dayPassId,
          studioId,
          userId,
          validForDate,
        },
      });

      paymentIntentId = paymentIntent.id;

      await this.prisma.dayPass.update({
        where: { id: dayPassId },
        data: { stripePaymentIntentId: paymentIntent.id },
      });

      paymentIntentSavedToDb = true;

      const ephemeralKey = await this.stripe.createEphemeralKey(customer.id, STRIPE_MOBILE_API_VERSION);

      const clientSecret = paymentIntent.client_secret;
      if (!clientSecret) {
        throw new BadRequestException('Stripe PaymentIntent did not return a client secret');
      }
      const ephemeralKeySecret = ephemeralKey.secret;
      if (!ephemeralKeySecret) {
        throw new BadRequestException('Stripe EphemeralKey did not return a secret');
      }

      const publishableKey = this.config.getOrThrow<string>('STRIPE_PUBLISHABLE_KEY');

      return {
        dayPassId,
        paymentIntentClientSecret: clientSecret,
        customerId: customer.id,
        ephemeralKeySecret,
        publishableKey,
      };
    } catch (err) {
      await this.rollbackNewPendingDayPass(
        dayPassId,
        paymentIntentSavedToDb ? paymentIntentId : null,
      );
      throw err;
    }
  }

  private async rollbackNewPendingDayPass(
    dayPassId: string,
    stripePaymentIntentId: string | null,
  ): Promise<void> {
    try {
      await this.prisma.dayPass.deleteMany({
        where: {
          id: dayPassId,
          status: DayPassStatus.PENDING,
          stripePaymentIntentId,
        },
      });
    } catch {
      // Best-effort. The original error is already propagating; do not mask it.
    }
  }
}
