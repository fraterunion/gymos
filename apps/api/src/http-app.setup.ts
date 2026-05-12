import { RequestMethod, ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Application } from 'express';
import helmet from 'helmet';

export function configureHttpApp(app: unknown): void {
  const nest = app as INestApplication;
  const config = nest.get(ConfigService);
  const expressApp = nest.getHttpAdapter().getInstance() as Application;
  expressApp.set('trust proxy', 1);

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
