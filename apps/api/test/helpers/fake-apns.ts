import * as http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import * as forge from 'node-forge';

export type FakeApnsReply = { status: number; reason?: string };

/**
 * A LOCAL HTTP/2 server standing in for APNs (mutual TLS against the test WWDR, like the real
 * one). Tests point the real ApnsClient at it; nothing here can reach Apple. `reply` decides the
 * answer per push token; every request is recorded as {token, topic, body}.
 */
export class FakeApns {
  readonly received: Array<{ token: string; topic: string; body: string }> = [];
  reply: (token: string) => FakeApnsReply = () => ({ status: 200 });
  private server: http2.Http2SecureServer | null = null;
  readonly certPem: string;
  private readonly keyPem: string;
  host = '';

  constructor(private readonly wwdrPem: string) {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date(Date.now() - 60_000);
    cert.validity.notAfter = new Date(Date.now() + 3_600_000);
    cert.setSubject([{ name: 'commonName', value: 'localhost' }]);
    cert.setIssuer([{ name: 'commonName', value: 'localhost' }]);
    cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    this.certPem = forge.pki.certificateToPem(cert);
    this.keyPem = forge.pki.privateKeyToPem(keys.privateKey);
  }

  async start(): Promise<void> {
    const server = http2.createSecureServer({ cert: this.certPem, key: this.keyPem, requestCert: true, rejectUnauthorized: true, ca: this.wwdrPem });
    server.on('stream', (stream, headers) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        const token = String(headers[':path']).split('/').pop() ?? '';
        this.received.push({ token, topic: String(headers['apns-topic']), body: Buffer.concat(chunks).toString('utf8') });
        const { status, reason } = this.reply(token);
        stream.respond({ ':status': status, 'content-type': 'application/json', 'apns-id': '22222222-2222-4222-8222-222222222222' });
        stream.end(status === 200 ? '' : JSON.stringify({ reason: reason ?? 'Unknown' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.server = server;
    this.host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  reset(): void {
    this.received.length = 0;
    this.reply = () => ({ status: 200 });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = null;
  }
}
