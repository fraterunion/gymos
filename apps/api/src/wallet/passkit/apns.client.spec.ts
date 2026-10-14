import * as http2 from 'node:http2';
// The module object itself (not the namespace wrapper), so the spy below is what
// apns.client.ts sees when it calls http2.connect.
import http2Module from 'node:http2';
import type { AddressInfo } from 'node:net';
import * as forge from 'node-forge';
import { loadP12 } from '../apple/pkpass-signer';
import { generateTestApplePkiFixture } from '../apple/test-cert-fixture';
import { ApnsClient } from './apns.client';

/**
 * Exercises the real HTTP/2 + TLS client-certificate path against a LOCAL server standing in
 * for APNs. Nothing here can reach Apple: http2.connect is wrapped to throw for any apple.com
 * authority, and every client in this file targets 127.0.0.1.
 */
const realConnect = http2Module.connect;
beforeAll(() => {
  jest.spyOn(http2Module, 'connect').mockImplementation(((authority: string | URL, ...rest: unknown[]) => {
    if (String(authority).includes('apple.com')) {
      throw new Error('Tests must never contact live APNs');
    }
    return (realConnect as (...a: unknown[]) => http2.ClientHttp2Session)(authority, ...rest);
  }) as typeof http2.connect);
});
afterAll(() => jest.restoreAllMocks());

/** Self-signed server certificate for 127.0.0.1, generated in-process (no openssl needed). */
function localServerIdentity(): { certPem: string; keyPem: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 3_600_000);
  const attrs = [{ name: 'commonName', value: 'localhost' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }, { type: 2, value: 'localhost' }] },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: forge.pki.privateKeyToPem(keys.privateKey) };
}

type Received = { path: string; topic: string | undefined; body: string; clientCertCn: string | null; method: string };

const fixture = generateTestApplePkiFixture();
const maybeDescribe = fixture ? describe : describe.skip;

maybeDescribe('ApnsClient (local HTTP/2 server, test PKI)', () => {
  const serverIdentity = localServerIdentity();
  const clientIdentity = (() => {
    if (!fixture) return { certPem: '', keyPem: '', wwdrPem: '' };
    const p12 = loadP12(fixture.p12Base64, fixture.p12Password);
    return {
      certPem: forge.pki.certificateToPem(p12.cert),
      keyPem: forge.pki.privateKeyToPem(p12.privateKey as forge.pki.rsa.PrivateKey),
      wwdrPem: Buffer.from(fixture.wwdrPemBase64, 'base64').toString('utf8'),
    };
  })();

  let server: http2.Http2SecureServer;
  let host: string;
  const received: Received[] = [];
  const responses = new Map<string, { status: number; body?: string; hang?: boolean }>();

  beforeAll(async () => {
    server = http2.createSecureServer({
      cert: serverIdentity.certPem,
      key: serverIdentity.keyPem,
      // Like APNs: demand a client certificate and verify it against the issuing CA.
      requestCert: true,
      rejectUnauthorized: true,
      ca: clientIdentity.wwdrPem,
    });
    server.on('stream', (stream, headers) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        const path = String(headers[':path']);
        const socket = stream.session?.socket as unknown as { getPeerCertificate?: () => { subject?: { CN?: string } } };
        received.push({
          path,
          method: String(headers[':method']),
          topic: headers['apns-topic'] as string | undefined,
          body: Buffer.concat(chunks).toString('utf8'),
          clientCertCn: socket?.getPeerCertificate?.()?.subject?.CN ?? null,
        });
        const token = path.split('/').pop()!;
        const r = responses.get(token) ?? { status: 200 };
        if (r.hang) return; // never answer: exercises the client timeout
        stream.respond({ ':status': r.status, 'content-type': 'application/json', 'apns-id': `00000000-0000-4000-8000-${token.padStart(12, '0').slice(-12)}` });
        stream.end(r.body ?? '');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    received.length = 0;
    responses.clear();
  });

  function client(timeoutMs?: number) {
    return new ApnsClient({ host, certPem: clientIdentity.certPem, keyPem: clientIdentity.keyPem, ca: serverIdentity.certPem, timeoutMs });
  }

  it('sends Apple\'s pass-update request: POST /3/device/<token>, topic = pass type id, body {}, client cert', async () => {
    const c = client();
    try {
      await expect(c.sendPassUpdate('aabbccdd00112233', 'pass.co.gymos.member.test')).resolves.toEqual({
        ok: true,
        status: 200,
        apnsId: '00000000-0000-4000-8000-ccdd00112233',
      });
    } finally {
      c.close();
    }
    expect(received).toEqual([
      {
        path: '/3/device/aabbccdd00112233',
        method: 'POST',
        topic: 'pass.co.gymos.member.test',
        body: '{}',
        clientCertCn: 'Test Pass Type ID',
      },
    ]);
  });

  it('marks 410 Unregistered and BadDeviceToken as permanently invalid tokens; 5xx as transient', async () => {
    responses.set('dead0001', { status: 410, body: JSON.stringify({ reason: 'Unregistered' }) });
    responses.set('dead0002', { status: 400, body: JSON.stringify({ reason: 'BadDeviceToken' }) });
    responses.set('beef0003', { status: 503, body: JSON.stringify({ reason: 'ServiceUnavailable' }) });
    const c = client();
    try {
      await expect(c.sendPassUpdate('dead0001', 'pass.x')).resolves.toEqual({ ok: false, status: 410, reason: 'Unregistered', tokenInvalid: true, apnsId: '00000000-0000-4000-8000-0000dead0001' });
      await expect(c.sendPassUpdate('dead0002', 'pass.x')).resolves.toEqual({ ok: false, status: 400, reason: 'BadDeviceToken', tokenInvalid: true, apnsId: '00000000-0000-4000-8000-0000dead0002' });
      await expect(c.sendPassUpdate('beef0003', 'pass.x')).resolves.toEqual({ ok: false, status: 503, reason: 'ServiceUnavailable', tokenInvalid: false, apnsId: '00000000-0000-4000-8000-0000beef0003' });
    } finally {
      c.close();
    }
    expect(received).toHaveLength(3); // one HTTP/2 session, three streams
  });

  it('times out a request that never gets an answer, without hanging the batch', async () => {
    responses.set('slow0004', { status: 200, hang: true });
    const c = client(300);
    try {
      await expect(c.sendPassUpdate('slow0004', 'pass.x')).resolves.toMatchObject({ ok: false, reason: 'Timeout', tokenInvalid: false });
    } finally {
      c.close();
    }
  });

  it('a server that does not trust the client certificate fails the push, it does not throw', async () => {
    const stranger = localServerIdentity();
    const c = new ApnsClient({ host, certPem: stranger.certPem, keyPem: stranger.keyPem, ca: serverIdentity.certPem, timeoutMs: 2000 });
    try {
      const result = await c.sendPassUpdate('aabbccdd00112233', 'pass.x');
      expect(result.ok).toBe(false);
    } finally {
      c.close();
    }
    expect(received).toHaveLength(0);
  });

  it('refuses to connect to Apple from tests (guard is active)', async () => {
    const c = new ApnsClient({ host: 'api.push.apple.com', certPem: clientIdentity.certPem, keyPem: clientIdentity.keyPem });
    await expect(c.sendPassUpdate('aabbccdd00112233', 'pass.x')).resolves.toMatchObject({ ok: false, reason: 'ConnectionFailed' });
    c.close();
  });
});
