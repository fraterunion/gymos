import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../../src/app.module';
import { configureHttpApp } from '../../src/http-app.setup';
import { PrismaService } from '../../src/prisma/prisma.service';
import { StripeService } from '../../src/stripe/stripe.service';
import { createE2eStripeServiceMock } from './stripe-service.e2e-mock';

/**
 * Pins the dedicated e2e database's default session timezone to UTC, so naked
 * `timestamp` columns (stored as UTC wall time) compare against `timestamptz`
 * bind parameters exactly as they do in CI and production, whose sessions run
 * UTC. Without this, a local Postgres defaulting to the developer's timezone
 * shifts every raw-SQL timestamp comparison by the session offset, and
 * date-boundary fixtures fail locally while passing in CI.
 * Runs before the app's connection pool opens; ALTER DATABASE only affects new
 * sessions. Idempotent, and a no-op for roles without ALTER privilege.
 */
async function pinTestDatabaseTimezoneUtc(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) return;
  const dbName = new URL(url).pathname.replace(/^\//, '').split('?')[0];
  if (!dbName) return;
  const client = new PrismaClient();
  try {
    await client.$executeRawUnsafe(`ALTER DATABASE "${dbName}" SET timezone TO 'UTC'`);
  } catch {
    // Role cannot ALTER DATABASE — keep the server's default session timezone.
  } finally {
    await client.$disconnect();
  }
}

/**
 * Boots the Nest application for e2e with Stripe HTTP calls mocked (no real Stripe network).
 * Uses `Test.createTestingModule` so `StripeService` can be overridden while keeping the
 * real `constructWebhookEvent` path for signature verification tests.
 */
export async function createTestApp(): Promise<INestApplication> {
  await pinTestDatabaseTimezoneUtc();
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
  // Listen once, on the IPv4 loopback address supertest connects to. Left unbound, supertest
  // re-listens on an OS-chosen port of the IPv6 wildcard (::) for every request while sending to
  // 127.0.0.1 — and on macOS any other local process may bind 127.0.0.1:<that port> and answer
  // instead (seen as intermittent 404/401 on valid routes and tokens). Binding 127.0.0.1 makes
  // such a bind fail (EADDRINUSE) and reuses one server per suite.
  await app.listen(0, '127.0.0.1');
  return app;
}
