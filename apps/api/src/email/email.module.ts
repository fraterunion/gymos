import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { EMAIL_PROVIDER, type EmailProvider } from './email-provider';
import { LoggingEmailProvider } from './providers/logging-email.provider';
import { ResendEmailProvider } from './providers/resend-email.provider';
import { TransactionalEmailService } from './transactional-email.service';

/**
 * Provider selection happens exactly once, here. With RESEND_API_KEY set the platform
 * delivers through Resend; without it (local dev, CI, e2e) it falls back to a provider
 * that delivers nothing, so a missing key can never turn into accidental real email.
 */
@Module({
  imports: [ConfigModule, PrismaModule],
  providers: [
    {
      provide: EMAIL_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): EmailProvider => {
        const apiKey = config.get<string>('RESEND_API_KEY', '').trim();
        if (apiKey) {
          return new ResendEmailProvider({ apiKey });
        }
        // Defence in depth: validateEnv already refuses this combination at boot, so
        // reaching it means configuration drifted. Fail loudly rather than serve a
        // recovery flow that quietly delivers nothing.
        const isProduction = config.get<string>('NODE_ENV', 'development') === 'production';
        const recoveryEnabled = config.get<string>('PASSWORD_RECOVERY_ENABLED', 'false') === 'true';
        if (isProduction && recoveryEnabled) {
          throw new Error(
            'PASSWORD_RECOVERY_ENABLED=true in production requires RESEND_API_KEY — refusing to start with email suppressed.',
          );
        }
        new Logger('EmailModule').warn(
          'RESEND_API_KEY is not set — transactional email is suppressed (nothing will be delivered).',
        );
        return new LoggingEmailProvider();
      },
    },
    TransactionalEmailService,
  ],
  exports: [TransactionalEmailService, EMAIL_PROVIDER],
})
export class EmailModule {}
