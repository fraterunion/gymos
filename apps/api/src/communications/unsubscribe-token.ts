import { createHmac, timingSafeEqual } from 'node:crypto';

type UnsubscribePayload = { studioId: string; email: string };

export function signUnsubscribeToken(payload: UnsubscribePayload, secret: string): string {
  const body = Buffer.from(JSON.stringify({
    studioId: payload.studioId,
    email: payload.email.trim().toLowerCase(),
  })).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function readUnsubscribeToken(token: string, secret: string): UnsubscribePayload | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as UnsubscribePayload;
    if (!parsed.studioId || !parsed.email || !parsed.email.includes('@')) return null;
    return { studioId: parsed.studioId, email: parsed.email.trim().toLowerCase() };
  } catch {
    return null;
  }
}
