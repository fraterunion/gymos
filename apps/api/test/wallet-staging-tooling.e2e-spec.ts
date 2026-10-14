// Must stay the first import: sets the Smart Wallet env before AppModule is imported.
import './helpers/wallet-dynamic-env.on';
import type { INestApplication } from '@nestjs/common';
import { WalletPassMode, WalletPassPlatform } from '@prisma/client';
import request from 'supertest';
import { exportPass, Refusal, seed, setEntitlement, status } from '../src/cli/wallet-staging.commands';
import { PrismaService } from '../src/prisma/prisma.service';
import { AppleWalletProvider } from '../src/wallet/apple/apple-wallet-provider.service';
import { extractPassJsonFromPkpass } from '../src/wallet/apple/pkpass-reader';
import { WalletDynamicPassService } from '../src/wallet/dynamic/wallet-dynamic-pass.service';
import { WalletPassService } from '../src/wallet/wallet-pass.service';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import { createStudio } from './helpers/factories';
import { appleFixture, DYNAMIC_PASS_TYPE } from './helpers/wallet-dynamic-env';

/**
 * The staging-only tooling's commands, exercised on the isolated test database. The CLI's
 * environment guard (staging-guard.spec.ts) is what keeps these away from production; here we
 * prove what the commands do once allowed to run.
 */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const spy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  });
  const errSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await fn();
  } finally {
    spy.mockRestore();
    errSpy.mockRestore();
  }
  return chunks.join('');
}

function lastJson(output: string): Record<string, unknown> {
  const lines = output.trim().split('\n').filter((l) => l.startsWith('{'));
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

const maybeDescribe = appleFixture ? describe : describe.skip;

maybeDescribe('Smart Wallet staging tooling (e2e, isolated test DB)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  const runSeed = () => captureStdout(() => seed(prisma, app.get(WalletPassService), app.get(AppleWalletProvider)));

  it('seeds one synthetic studio and two members with STATIC passes, idempotently, never printing a QR value', async () => {
    const first = lastJson(await runSeed());
    const members = first['members'] as Array<{ member: string; walletCredentialId: string; passMode: string; templateVersion: number; qrFingerprint: string }>;
    expect(members.map((m) => [m.member, m.passMode, m.templateVersion])).toEqual([
      ['a', 'STATIC', 2],
      ['b', 'STATIC', 2],
    ]);
    for (const m of members) expect(m.qrFingerprint).toMatch(/^[0-9a-f]{12}$/);

    const again = lastJson(await runSeed());
    expect((again['members'] as typeof members).map((m) => [m.walletCredentialId, m.qrFingerprint])).toEqual(
      members.map((m) => [m.walletCredentialId, m.qrFingerprint]),
    );
    expect(await prisma.studio.count()).toBe(1);
    expect(await prisma.user.count()).toBe(2);
    expect(await prisma.walletCredential.count()).toBe(2);

    const raw = await prisma.walletPassArtifact.findMany({ where: { platform: WalletPassPlatform.APPLE }, select: { pkpassData: true } });
    const barcodes = await Promise.all(
      raw.map(async (r) => ((await extractPassJsonFromPkpass(Buffer.from(r.pkpassData!))) as { barcodes: Array<{ message: string }> }).barcodes[0]!.message),
    );
    const printed = JSON.stringify(first) + JSON.stringify(again);
    for (const b of barcodes) expect(printed).not.toContain(b.slice('gymos:v1:'.length));
  });

  it('refuses a database that holds anything but its own synthetic data', async () => {
    await createStudio(prisma, { slug: 'some-real-looking-studio' });
    await expect(seed(prisma, app.get(WalletPassService), app.get(AppleWalletProvider))).rejects.toThrow(
      new Refusal('DATABASE_IS_NOT_THE_EMPTY_STAGING_DATABASE'),
    );
    expect(await prisma.user.count()).toBe(0);
  });

  it('the controlled entitlement change drives a dynamic update with the same serial, QR and token', async () => {
    const seeded = lastJson(await runSeed());
    const a = (seeded['members'] as Array<{ member: string; walletCredentialId: string; qrFingerprint: string }>)[0]!;
    const dynamic = app.get(WalletDynamicPassService);
    await expect(dynamic.enroll(a.walletCredentialId)).resolves.toMatchObject({ outcome: 'enrolled', overall: 'ACCESS_VALID' });
    const v1 = await prisma.walletPassArtifact.findUniqueOrThrow({
      where: { walletCredentialId_platform: { walletCredentialId: a.walletCredentialId, platform: WalletPassPlatform.APPLE } },
    });
    const pass1 = (await extractPassJsonFromPkpass(Buffer.from(v1.pkpassData!))) as { authenticationToken: string; generic: { headerFields: Array<{ value: string }> } };
    expect(pass1.generic.headerFields[0]!.value).toBe('VIGENTE');

    const changed = lastJson(await captureStdout(() => setEntitlement(prisma, 'a', 'expired')));
    expect(changed).toMatchObject({ event: 'wallet_staging_entitlement_set', member: 'a', state: 'expired' });
    await expect(dynamic.refresh(a.walletCredentialId)).resolves.toMatchObject({ outcome: 'updated', passVersion: 2, overall: 'INACTIVE' });

    const v2 = await prisma.walletPassArtifact.findUniqueOrThrow({ where: { id: v1.id } });
    const pass2 = (await extractPassJsonFromPkpass(Buffer.from(v2.pkpassData!))) as { serialNumber: string; authenticationToken: string; generic: { headerFields: Array<{ value: string }> } };
    expect(pass2.generic.headerFields[0]!.value).toBe('VENCIDA');
    expect(pass2.serialNumber).toBe(a.walletCredentialId);
    expect(pass2.authenticationToken).toBe(pass1.authenticationToken);

    const st = lastJson(await captureStdout(() => status(prisma)));
    const stA = (st['members'] as Array<{ member: string; qrFingerprint: string; passMode: string; passVersion: number }>)[0]!;
    expect(stA).toMatchObject({ passMode: WalletPassMode.DYNAMIC, passVersion: 2, qrFingerprint: a.qrFingerprint });

    await expect(setEntitlement(prisma, 'a', 'cancelled')).rejects.toThrow(new Refusal('STATE_MUST_BE_active_OR_expired'));
  });

  it('export round-trips the stored pass bytes between markers; status never prints device ids or push tokens', async () => {
    const seeded = lastJson(await runSeed());
    const b = (seeded['members'] as Array<{ member: string; walletCredentialId: string }>)[1]!;
    await app.get(WalletDynamicPassService).enroll(b.walletCredentialId);
    const stored = await prisma.walletPassArtifact.findUniqueOrThrow({
      where: { walletCredentialId_platform: { walletCredentialId: b.walletCredentialId, platform: WalletPassPlatform.APPLE } },
    });

    const exported = await captureStdout(() => exportPass(prisma, 'b'));
    const match = /-----BEGIN PKPASS-----\n([\s\S]*?)\n-----END PKPASS-----/.exec(exported);
    expect(match).not.toBeNull();
    expect(match![1]!.split('\n').every((line) => line.length <= 76)).toBe(true);
    expect(Buffer.from(match![1]!.replace(/\n/g, ''), 'base64').equals(Buffer.from(stored.pkpassData!))).toBe(true);

    const token = ((await extractPassJsonFromPkpass(Buffer.from(stored.pkpassData!))) as { authenticationToken: string }).authenticationToken;
    const device = 'staging-device-0123456789abcdef';
    const pushToken = 'ab'.repeat(32);
    await request(app.getHttpServer())
      .post(`/api/v1/wallet/passkit/v1/devices/${device}/registrations/${DYNAMIC_PASS_TYPE}/${b.walletCredentialId}`)
      .set('Authorization', `ApplePass ${token}`)
      .send({ pushToken })
      .expect(201);

    const printed = await captureStdout(() => status(prisma));
    const stB = (lastJson(printed)['members'] as Array<{ member: string; registrations: Array<{ device: string; pushTokenLength: number }> }>)[1]!;
    expect(stB.registrations).toEqual([expect.objectContaining({ device: expect.stringMatching(/^[0-9a-f]{12}$/), pushTokenLength: 64 })]);
    expect(printed).not.toContain(device);
    expect(printed).not.toContain(pushToken);
    expect(printed).not.toContain(token);
  });
});
