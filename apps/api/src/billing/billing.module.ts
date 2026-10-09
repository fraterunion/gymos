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
import { EmailModule } from '../email/email.module';
import { BillingAlertService } from './reconciliation/billing-alert.service';
import { BillingCaseService } from './reconciliation/billing-case.service';
import { BillingDetectorsService } from './reconciliation/billing-detectors.service';
import { BillingReconciliationController } from './reconciliation/billing-reconciliation.controller';
import { BillingReconciliationRunService } from './reconciliation/billing-reconciliation-run.service';

@Module({
  imports: [PrismaModule, StripeModule, EnrollmentModule, WaiverModule, EmailModule],
  controllers: [StudioBillingController, StripeWebhookController, BillingReconciliationController],
  providers: [
    BillingService,
    SubscriptionLifecycleService,
    SubscriptionReconciliationService,
    StripeToCashTransitionService,
    StripeRenewalAuditService,
    StripeWebhookService,
    BillingCaseService,
    BillingDetectorsService,
    BillingAlertService,
    BillingReconciliationRunService,
  ],
  exports: [
    BillingService,
    SubscriptionLifecycleService,
    SubscriptionReconciliationService,
    StripeToCashTransitionService,
    StripeRenewalAuditService,
    BillingCaseService,
    BillingDetectorsService,
    BillingReconciliationRunService,
    StripeModule,
  ],
})
export class BillingModule {}
