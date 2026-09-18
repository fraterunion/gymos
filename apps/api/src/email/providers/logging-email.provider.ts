import { Injectable, Logger } from '@nestjs/common';
import type { EmailMessage, EmailProvider, EmailSendResult } from '../email-provider';

/**
 * Fallback provider used when no delivery provider is configured (local dev, CI, e2e).
 * It NEVER delivers anything, and it never logs the message body — a password reset body
 * contains the one-time token, so logging it would defeat the point of hashing the token
 * in the database. Only non-sensitive envelope metadata is recorded.
 */
@Injectable()
export class LoggingEmailProvider implements EmailProvider {
  readonly name = 'logging';
  private readonly logger = new Logger(LoggingEmailProvider.name);

  async send(message: EmailMessage): Promise<EmailSendResult> {
    this.logger.log(
      JSON.stringify({
        event: 'transactional_email_suppressed',
        reason: 'no_email_provider_configured',
        subject: message.subject,
        recipientDomain: message.to.split('@')[1] ?? null,
        from: message.from.email,
        tags: message.tags ?? {},
      }),
    );
    return { providerMessageId: null, delivered: false };
  }
}
