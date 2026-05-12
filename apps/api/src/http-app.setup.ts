import { RequestMethod, ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Application, Request } from 'express';
import express from 'express';
import helmet from 'helmet';

function isStripeWebhookPost(req: Request): boolean {
  if (req.method !== 'POST') {
    return false;
  }
  const path = (req.originalUrl ?? req.url ?? '').split('?')[0];
  return path === '/api/v1/stripe/webhook';
}

export function configureHttpApp(app: unknown): void {
  const nest = app as INestApplication;
  const config = nest.get(ConfigService);
  const expressApp = nest.getHttpAdapter().getInstance() as Application;
  expressApp.set('trust proxy', 1);

  expressApp.use((req, res, next) => {
    if (isStripeWebhookPost(req)) {
      return express.raw({ type: 'application/json', limit: '2mb' })(req, res, next);
    }
    next();
  });
  expressApp.use((req, res, next) => {
    if (isStripeWebhookPost(req)) {
      return next();
    }
    express.json({ limit: '2mb' })(req, res, next);
  });
  expressApp.use((req, res, next) => {
    if (isStripeWebhookPost(req)) {
      return next();
    }
    express.urlencoded({ extended: true, limit: '1mb' })(req, res, next);
  });

  const nodeEnv = config.get<string>('NODE_ENV', 'development');
  nest.use(
    helmet({
      contentSecurityPolicy: false,
      hsts: nodeEnv === 'production' ? undefined : false,
    }),
  );

  nest.setGlobalPrefix('api/v1', {
    exclude: [{ path: 'health', method: RequestMethod.GET }],
  });

  nest.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  const corsOrigin = config.getOrThrow<string>('CORS_ORIGIN');
  nest.enableCors({
    origin: corsOrigin.split(',').map((o) => o.trim()),
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });
}
