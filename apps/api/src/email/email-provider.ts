/**
 * Provider-agnostic transactional email seam. Everything above this line in the stack
 * (auth, future notification flows) depends on THIS interface and never on a vendor SDK,
 * so swapping Resend for SES/Postmark is a one-file change in providers/.
 */

export const EMAIL_PROVIDER = Symbol('GYMOS_EMAIL_PROVIDER');

export type EmailAddress = { email: string; name?: string };

export type EmailMessage = {
  to: string;
  from: EmailAddress;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  /** Free-form tags for provider dashboards. Never include credentials or tokens. */
  tags?: Record<string, string>;
};

export type EmailSendResult = {
  /** Provider-side id when the provider returns one; null for non-delivering providers. */
  providerMessageId: string | null;
  /** False when the message was intentionally not delivered (e.g. no provider configured). */
  delivered: boolean;
};

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<EmailSendResult>;
}
