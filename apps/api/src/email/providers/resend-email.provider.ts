import { Injectable, Logger } from '@nestjs/common';
import type { EmailMessage, EmailProvider, EmailSendResult } from '../email-provider';

/**
 * Resend behind the EmailProvider seam, spoken over its REST API with fetch — no vendor
 * SDK is added to the dependency tree, and nothing outside this file imports Resend.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const REQUEST_TIMEOUT_MS = 10_000;

export type ResendProviderOptions = {
  apiKey: string;
  endpoint?: string;
  timeoutMs?: number;
};

@Injectable()
export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend';
  private readonly logger = new Logger(ResendEmailProvider.name);
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(options: ResendProviderOptions) {
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint ?? RESEND_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: message.from.name
            ? `${message.from.name} <${message.from.email}>`
            : message.from.email,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
          ...(message.replyTo ? { reply_to: message.replyTo } : {}),
          ...(message.tags
            ? { tags: Object.entries(message.tags).map(([name, value]) => ({ name, value })) }
            : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        // Body may carry provider diagnostics; it never contains our token because the
        // token only ever appears inside the rendered message body we just sent.
        const detail = await res.text().catch(() => '');
        throw new Error(`Resend responded ${res.status}: ${detail.slice(0, 300)}`);
      }

      const body = (await res.json().catch(() => ({}))) as { id?: string };
      return { providerMessageId: body.id ?? null, delivered: true };
    } finally {
      clearTimeout(timer);
    }
  }
}
