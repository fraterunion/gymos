import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StripeModule } from '../stripe/stripe.module';
import { BillingService } from './billing.service';
import { StripeWebhookController } from './stripe-webhook.controller';
import { StripeWebhookService } from './stripe-webhook.service';
import { StudioBillingController } from './studio-billing.controller';

@Module({
  imports: [PrismaModule, StripeModule],
  controllers: [StudioBillingController, StripeWebhookController],
  providers: [BillingService, StripeWebhookService],
  exports: [BillingService, StripeModule],
})
export class BillingModule {}
