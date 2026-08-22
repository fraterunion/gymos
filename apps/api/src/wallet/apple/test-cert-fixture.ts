import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Generates a throwaway, self-signed certificate chain via the system `openssl` binary,
 * shaped exactly like a real Pass Type ID cert + WWDR intermediate, so the REAL signing
 * code path (pkpass-signer.ts) can be exercised in tests without any real Apple credential.
 * Nothing here is committed — everything is generated fresh in a temp directory per call
 * and deleted immediately after. Skips (returns null) if `openssl` isn't on PATH, so CI
 * environments without it degrade to skipping the signing-path test rather than failing.
 */
export function generateTestApplePkiFixture():
  | { p12Base64: string; p12Password: string; wwdrPemBase64: string }
  | null {
  const dir = mkdtempSync(join(tmpdir(), 'gymos-wallet-test-cert-'));
  const password = 'test-pass-1234';
  try {
    const run = (args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });

    run(['req', '-x509', '-newkey', 'rsa:2048', '-keyout', 'wwdr-key.pem', '-out', 'wwdr-cert.pem', '-days', '1', '-nodes', '-subj', '/CN=Test WWDR']);
    run(['req', '-newkey', 'rsa:2048', '-keyout', 'leaf-key.pem', '-out', 'leaf.csr', '-nodes', '-subj', '/CN=Test Pass Type ID']);
    run(['x509', '-req', '-in', 'leaf.csr', '-CA', 'wwdr-cert.pem', '-CAkey', 'wwdr-key.pem', '-CAcreateserial', '-out', 'leaf-cert.pem', '-days', '1']);
    try {
      run(['pkcs12', '-export', '-out', 'leaf.p12', '-inkey', 'leaf-key.pem', '-in', 'leaf-cert.pem', '-passout', `pass:${password}`, '-legacy']);
    } catch {
      // Older openssl builds don't support -legacy; the modern default is also forge-compatible.
      run(['pkcs12', '-export', '-out', 'leaf.p12', '-inkey', 'leaf-key.pem', '-in', 'leaf-cert.pem', '-passout', `pass:${password}`]);
    }

    const p12Base64 = readFileSync(join(dir, 'leaf.p12')).toString('base64');
    const wwdrPemBase64 = readFileSync(join(dir, 'wwdr-cert.pem')).toString('base64');
    return { p12Base64, p12Password: password, wwdrPemBase64 };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
