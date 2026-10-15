import * as http2 from 'node:http2';
import { Injectable } from '@nestjs/common';

export type ApnsClientOptions = {
  /** host[:port]. Production Wallet pushes only work against api.push.apple.com. */
  host: string;
  /** Pass Type ID certificate + key (PEM) — the same identity that signs the passes. */
  certPem: string;
  keyPem: string;
  /** Extra trust anchor for a non-Apple test server. Never set in production. */
  ca?: string;
  timeoutMs?: number;
};

/**
 * `apnsId` is the apns-id response header: Apple's identifier for this notification, safe to log
 * and the key Apple support uses to trace a delivery. Never the push token.
 */
export type ApnsSendResult =
  | { ok: true; status: 200; apnsId: string | null }
  | { ok: false; status: number | null; reason: string | null; tokenInvalid: boolean; apnsId: string | null };

/** APNs reasons meaning "this device token will never work for this topic again". */
const INVALID_TOKEN_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Minimal APNs provider client for Wallet pass updates (certificate-based TLS over HTTP/2).
 * Apple's contract for a pass update: topic = the pass type identifier, payload = an empty JSON
 * dictionary, authenticated with the certificate that signed the pass, production APNs only.
 *
 * One HTTP/2 session per batch; every request has a timeout; push tokens are never logged or
 * returned in errors.
 */
export class ApnsClient {
  private session: http2.ClientHttp2Session | null = null;

  constructor(private readonly options: ApnsClientOptions) {}

  async sendPassUpdate(pushToken: string, passTypeIdentifier: string): Promise<ApnsSendResult> {
    let session: http2.ClientHttp2Session;
    try {
      session = this.connect();
    } catch {
      return { ok: false, status: null, reason: 'ConnectionFailed', tokenInvalid: false, apnsId: null };
    }
    const body = Buffer.from('{}', 'utf8');

    return new Promise<ApnsSendResult>((resolve) => {
      let settled = false;
      const finish = (result: ApnsSendResult) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };

      let req: http2.ClientHttp2Stream;
      try {
        req = session.request({
          ':method': 'POST',
          ':path': `/3/device/${encodeURIComponent(pushToken)}`,
          'apns-topic': passTypeIdentifier,
          'content-type': 'application/json',
          'content-length': body.length,
        });
      } catch {
        finish({ ok: false, status: null, reason: 'RequestFailed', tokenInvalid: false, apnsId: null });
        return;
      }

      req.setTimeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS, () => {
        req.close(http2.constants.NGHTTP2_CANCEL);
        finish({ ok: false, status: null, reason: 'Timeout', tokenInvalid: false, apnsId });
      });

      let status: number | null = null;
      let apnsId: string | null = null;
      const chunks: Buffer[] = [];
      req.on('response', (headers) => {
        const s = headers[':status'];
        status = typeof s === 'number' ? s : null;
        const id = headers['apns-id'];
        apnsId = typeof id === 'string' && /^[0-9A-Fa-f-]{1,64}$/.test(id) ? id : null;
      });
      req.on('data', (chunk: Buffer) => {
        if (chunks.reduce((n, c) => n + c.length, 0) < 4096) chunks.push(chunk);
      });
      req.on('error', () => finish({ ok: false, status, reason: 'StreamError', tokenInvalid: false, apnsId }));
      // Backstop: a stream closed without a complete response still settles exactly once.
      req.on('close', () => finish({ ok: false, status, reason: 'StreamClosed', tokenInvalid: false, apnsId }));
      req.on('end', () => {
        if (status === 200) {
          finish({ ok: true, status: 200, apnsId });
          return;
        }
        let reason: string | null = null;
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { reason?: unknown };
          reason = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 64) : null;
        } catch {
          reason = null;
        }
        finish({
          ok: false,
          status,
          reason,
          tokenInvalid: status === 410 || (reason !== null && INVALID_TOKEN_REASONS.has(reason)),
          apnsId,
        });
      });

      req.end(body);
    });
  }

  close(): void {
    this.session?.close();
    this.session = null;
  }

  private connect(): http2.ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) {
      return this.session;
    }
    const session = http2.connect(`https://${this.options.host}`, {
      cert: this.options.certPem,
      key: this.options.keyPem,
      ...(this.options.ca ? { ca: this.options.ca } : {}),
    });
    // Connection-level failures surface per request as StreamError/ConnectionFailed.
    session.on('error', () => undefined);
    this.session = session;
    return session;
  }
}

/**
 * DI seam for creating APNs clients: production uses it as-is; tests replace `create` on the
 * instance to point the real client at a local HTTP/2 server. No configuration path exists that
 * changes the production host.
 */
@Injectable()
export class ApnsClientFactory {
  create(options: ApnsClientOptions): ApnsClient {
    return new ApnsClient(options);
  }
}
