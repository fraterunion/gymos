import type { Request } from 'express';

export function extractRequestClientMeta(req: Request): {
  ipAddress?: string;
  userAgent?: string;
} {
  const forwarded = req.headers['x-forwarded-for'];
  const ipFromForwarded =
    typeof forwarded === 'string'
      ? forwarded.split(',')[0]?.trim()
      : Array.isArray(forwarded)
        ? forwarded[0]?.split(',')[0]?.trim()
        : undefined;

  const ipAddress = ipFromForwarded || req.ip || req.socket?.remoteAddress || undefined;
  const userAgent =
    typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined;

  return { ipAddress, userAgent };
}
