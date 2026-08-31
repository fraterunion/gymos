import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StripeModule } from '../stripe/stripe.module';
import { EnrollmentModule } from '../enrollment/enrollment.module';
import { WaiverModule } from '../waiver/waiver.module';
import { BillingService } from './billing.service';
import { StripeToCashTransitionService } from './stripe-to-cash-transition.service';
import { StripeRenewalAuditService } from './stripe-renewal-audit.service';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';
import { SubscriptionReconciliationService } from './subscription-reconciliation.service';
import { StripeWebhookController } from './stripe-webhook.controller';
import { StripeWebhookService } from './stripe-webhook.service';
import { StudioBillingController } from './studio-billing.controller';

@Module({
  imports: [PrismaModule, StripeModule, EnrollmentModule, WaiverModule],
  controllers: [StudioBillingController, StripeWebhookController],
  providers: [
    BillingService,
    SubscriptionLifecycleService,
    SubscriptionReconciliationService,
    StripeToCashTransitionService,
    StripeRenewalAuditService,
    StripeWebhookService,
  ],
  exports: [
    BillingService,
    SubscriptionLifecycleService,
    SubscriptionReconciliationService,
    StripeToCashTransitionService,
    StripeRenewalAuditService,
    StripeModule,
  ],
})
export class BillingModule {}
