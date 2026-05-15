import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies Expo `expo-signature` header: hex HMAC-SHA1 of raw body with `sha1=` prefix.
 * @see https://docs.expo.dev/eas/webhooks/#webhook-server
 */
export function verifyExpoWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader?.trim()) return false;
  const expected = `sha1=${createHmac('sha1', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signatureHeader.trim(), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
