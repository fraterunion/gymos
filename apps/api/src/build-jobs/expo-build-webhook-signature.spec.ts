import { createHmac } from 'node:crypto';
import { verifyExpoWebhookSignature } from './expo-build-webhook-signature';

describe('verifyExpoWebhookSignature', () => {
  const secret = 'test-webhook-secret-min16';
  const body = Buffer.from('{"id":"abc","status":"finished"}', 'utf8');

  function sign(b: Buffer): string {
    return `sha1=${createHmac('sha1', secret).update(b).digest('hex')}`;
  }

  it('accepts a valid expo-signature', () => {
    expect(verifyExpoWebhookSignature(body, sign(body), secret)).toBe(true);
  });

  it('rejects wrong secret', () => {
    expect(verifyExpoWebhookSignature(body, sign(body), 'other-secret-min-16-chars')).toBe(false);
  });

  it('rejects missing header', () => {
    expect(verifyExpoWebhookSignature(body, undefined, secret)).toBe(false);
  });
});
