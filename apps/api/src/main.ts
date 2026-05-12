import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureHttpApp } from './http-app.setup';
import { PrismaService } from './prisma/prisma.service';

const API_PREFIX = 'api/v1';
const HEALTH_PATH = '/health';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const config = app.get(ConfigService);
  const prisma = app.get(PrismaService);
  prisma.enableShutdownHooks(app);
  app.enableShutdownHooks();

  configureHttpApp(app);

  const port = Number(config.get('PORT', '3000'));
  const nodeEnv = config.get<string>('NODE_ENV', process.env.NODE_ENV ?? 'development');

  await app.listen(port);

  logger.log(
    `Listening port=${port} env=${nodeEnv} health=GET ${HEALTH_PATH} apiPrefix=/${API_PREFIX}`,
  );
  logger.log(
    JSON.stringify({
      event: 'api_started',
      env: nodeEnv,
      port,
      healthPath: HEALTH_PATH,
      apiPrefix: `/${API_PREFIX}`,
    }),
  );
}

bootstrap().catch((err: unknown) => {
  const logger = new Logger('Bootstrap');
  if (err instanceof Error) {
    logger.error(err.message, err.stack);
  } else {
    logger.error(String(err));
  }
  process.exit(1);
});
