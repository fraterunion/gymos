import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../../src/app.module';
import { configureHttpApp } from '../../src/http-app.setup';
import { PrismaService } from '../../src/prisma/prisma.service';
import { StripeService } from '../../src/stripe/stripe.service';
import { createE2eStripeServiceMock } from './stripe-service.e2e-mock';

/**
 * Boots the Nest application for e2e with Stripe HTTP calls mocked (no real Stripe network).
 * Uses `Test.createTestingModule` so `StripeService` can be overridden while keeping the
 * real `constructWebhookEvent` path for signature verification tests.
 */
export async function createTestApp(): Promise<INestApplication> {
  const webhookSecret =
    process.env['STRIPE_WEBHOOK_SECRET']?.trim() ||
    'whsec_test_gymos_default_value_for_signature_tests_00001';
  const secretKey =
    process.env['STRIPE_SECRET_KEY']?.trim() || 'sk_test_REPLACE_ME';

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(StripeService)
    .useValue(createE2eStripeServiceMock({ webhookSecret, secretKey }))
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    logger: false,
  });
  const prisma = app.get(PrismaService);
  prisma.enableShutdownHooks(app);
  app.enableShutdownHooks();
  configureHttpApp(app);
  await app.init();
  return app;
}
