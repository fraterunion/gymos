import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AppModule } from './app.module';
import { configureHttpApp } from './http-app.setup';
import { PrismaService } from './prisma/prisma.service';

const API_PREFIX = 'api/v1';
const HEALTH_PATH = '/health';

// ---------------------------------------------------------------------------
// Deploy-source diagnostic — remove once Railway source/commit is confirmed.
// ---------------------------------------------------------------------------
function logDeploySourceCheck(logger: Logger): void {
  const DEPLOY_MARKER = 'DEPLOY_SOURCE_CHECK_ca129dc';

  // Candidate paths for metro.config.js — covers both Railway (/app) and local dev layouts.
  const metroConfigCandidates = [
    path.join(process.cwd(), 'apps', 'mobile', 'metro.config.js'),
    path.join(process.cwd(), '..', 'mobile', 'metro.config.js'),
    '/app/apps/mobile/metro.config.js',
  ];

  let metroConfigPath: string | null = null;
  let metroConfigSnippet: string | null = null;
  let hasWorkerThreadsKey: boolean | null = null;

  for (const candidate of metroConfigCandidates) {
    try {
      const raw = fs.readFileSync(candidate, 'utf8');
      metroConfigPath = candidate;
      metroConfigSnippet = raw.slice(0, 300);
      hasWorkerThreadsKey = raw.includes('unstable_workerThreads');
      break;
    } catch {
      // try next candidate
    }
  }

  let pkgVersion: string | null = null;
  try {
    const pkgPath = path.join(process.cwd(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string; name?: string };
    pkgVersion = pkg.version ?? null;
  } catch {
    // best-effort
  }

  logger.log(
    JSON.stringify({
      event: DEPLOY_MARKER,
      cwd: process.cwd(),
      pkgVersion,
      metroConfigPath,
      metroConfigFound: metroConfigPath !== null,
      // TRUE means the deprecated key is still present (fix not deployed)
      // FALSE means the fix IS deployed (key was deleted)
      // null means metro.config.js was not found at any candidate path
      metroConfigHasDeprecatedKey: hasWorkerThreadsKey,
      metroConfigSnippet,
    }),
  );
}

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  logDeploySourceCheck(logger);
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
