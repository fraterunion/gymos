import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { configureHttpApp } from '../../src/http-app.setup';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Boots the real Nest application (same wiring as production) for e2e.
 * Uses NestFactory instead of Test.createTestingModule so global providers
 * like Reflector resolve correctly for route-scoped guards (e.g. ThrottlerGuard).
 */
export async function createTestApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { logger: false });
  const prisma = app.get(PrismaService);
  prisma.enableShutdownHooks(app);
  app.enableShutdownHooks();
  configureHttpApp(app);
  await app.init();
  return app;
}
