// Must stay the first import: synthetic signing, dynamic + routes ON, APNs + worker OFF, Stage 4B ON.
import './helpers/wallet-stage4b-env.on';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WalletPassMode, WalletPassPlatform } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  exportPass,
  issueFirst,
  prepareFirstIssue,
  Refusal,
  seed,
  status,
} from '../src/cli/wallet-staging.commands';
import { PrismaService } from '../src/prisma/prisma.service';
import { AppleWalletProvider } from '../src/wallet/apple/apple-wallet-provider.service';
import { extractBarcodeMessageFromPkpass, extractPassJsonFromPkpass } from '../src/wallet/apple/pkpass-reader';
import { WalletPassService } from '../src/wallet/wallet-pass.service';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import { appleFixture, DYNAMIC_WEB_SERVICE_URL } from './helpers/wallet-dynamic-env';

/**
 * Stage 4B staging validation with synthetic member C, on the isolated test database:
 * C is prepared WITHOUT a credential, then issued through the production first-issuance path
 * (WalletPassService.getBarcode) with the allowlist set to exactly C. A and B — the previously
 * issued STATIC passes — must stay byte-identical throughout.
 */
async function capture(fn: () => Promise<void>): Promise<string> {
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

function events(output: string): Array<Record<string, unknown>> {
  return output.trim().split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>);
}

const maybeDescribe = appleFixture ? describe : describe.skip;

maybeDescribe('Smart Wallet staging tooling — Stage 4B first issue for synthetic member C (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let config: ConfigService;
  let liveOverrides: Record<string, string> = {};

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    config = app.get(ConfigService);
    // The live allowlist is read through this shared ConfigService instance by both the gate and
    // WalletPassService; point it at C's real (generated) ids once C is prepared.
    const original = config.get.bind(config);
    jest.spyOn(config, 'get').mockImplementation(((key: string) => (key in liveOverrides ? liveOverrides[key] : original(key))) as ConfigService['get']);
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    liveOverrides = {};
  });

  afterAll(async () => {
    await app.close();
  });

  const passes = () => app.get(WalletPassService);
  const apple = () => app.get(AppleWalletProvider);
  const runSeed = () => capture(() => seed(prisma, passes(), apple()));
  const runPrepare = () => capture(() => prepareFirstIssue(prisma, 'c'));
  const runIssue = () => capture(() => issueFirst(prisma, passes(), apple(), config, 'c'));

  async function fingerprints() {
    const rows = await prisma.walletPassArtifact.findMany({ orderBy: { id: 'asc' } });
    return rows.map((r) => ({
      id: r.id,
      walletCredentialId: r.walletCredentialId,
      platform: r.platform,
      passMode: r.passMode,
      passVersion: r.passVersion,
      updatedAt: r.updatedAt.toISOString(),
      sha256: r.pkpassData ? createHash('sha256').update(Buffer.from(r.pkpassData)).digest('hex') : null,
    }));
  }

  async function prepared() {
    const ev = events(await runPrepare()).find((e) => e['event'] === 'wallet_staging_first_issue_prepared')!;
    return ev as { studioId: string; userId: string; autoEnrollConfig: Record<string, string>; walletCredentials: number; configValidation: string };
  }

  function allowExactlyC(p: { studioId: string; userId: string }) {
    liveOverrides = { WALLET_AUTO_ENROLL_STUDIO_ID: p.studioId, WALLET_AUTO_ENROLL_USER_IDS: p.userId, WALLET_AUTO_ENROLL_STUDIO_CAP: '1' };
  }

  it('prepare creates C (user, membership, subscription) with NO credential and prints only C’s validated allowlist; A and B untouched', async () => {
    await runSeed();
    const before = await fingerprints();
    expect(before.map((f) => f.passMode)).toEqual(['STATIC', 'STATIC']);

    const output = await runPrepare();
    const p = events(output).find((e) => e['event'] === 'wallet_staging_first_issue_prepared') as Record<string, unknown>;
    const userId = p['userId'] as string;
    const studioId = p['studioId'] as string;
    expect(p).toMatchObject({ member: 'c', walletCredentials: 0, configValidation: 'PASSED', otherUsersAdmitted: 0 });
    expect(p['autoEnrollConfig']).toEqual({
      WALLET_AUTO_ENROLL_ENABLED: 'true',
      WALLET_AUTO_ENROLL_STUDIO_ID: studioId,
      WALLET_AUTO_ENROLL_USER_IDS: userId,
      WALLET_AUTO_ENROLL_STUDIO_CAP: '1',
    });
    expect(await prisma.walletCredential.count({ where: { userId } })).toBe(0);
    expect(await prisma.studioMembership.count({ where: { userId, studioId, role: 'MEMBER' } })).toBe(1);
    expect(await prisma.subscription.count({ where: { userId, studioId, status: 'ACTIVE' } })).toBe(1);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(output).not.toContain(user.passwordHash!);
    expect(await fingerprints()).toEqual(before);

    // Idempotent: same ids, still no credential, still three users.
    const again = await prepared();
    expect([again.userId, again.studioId]).toEqual([userId, studioId]);
    expect(await prisma.user.count()).toBe(3);
    expect(await prisma.walletCredential.count()).toBe(2);
  });

  it('prepare refuses before the staging studio is seeded, and on a database holding foreign data', async () => {
    await expect(prepareFirstIssue(prisma, 'c')).rejects.toThrow(new Refusal('STAGING_NOT_SEEDED'));
    await prisma.studio.create({ data: { name: 'Looks Real', slug: 'looks-real', timezone: 'America/Mexico_City' } });
    await expect(prepareFirstIssue(prisma, 'c')).rejects.toThrow(new Refusal('DATABASE_IS_NOT_THE_EMPTY_STAGING_DATABASE'));
    expect(await prisma.user.count()).toBe(0);
  });

  it('issue-first refuses (writing nothing) unless the LIVE allowlist is exactly C', async () => {
    await runSeed();
    const p = await prepared();
    const before = await fingerprints();
    const credentialsBefore = await prisma.walletCredential.count();

    // Boot placeholders (another studio / another user): refused.
    const out1 = events(await capture(() => expect(issueFirst(prisma, passes(), apple(), config, 'c')).rejects.toThrow(new Refusal('FIRST_ISSUE_GATE_FAILED'))));
    expect(out1.find((e) => e['event'] === 'wallet_staging_first_issue_gate')).toMatchObject({
      passed: false,
      problems: expect.arrayContaining(['STUDIO_IS_NOT_THE_SYNTHETIC_STAGING_STUDIO', 'ALLOWLIST_IS_NOT_EXACTLY_THIS_MEMBER']),
    });

    // C plus an existing credential holder (A), cap 2: refused.
    const a = await prisma.user.findUniqueOrThrow({ where: { email: 'sw-staging-a@staging.invalid' } });
    liveOverrides = { WALLET_AUTO_ENROLL_STUDIO_ID: p.studioId, WALLET_AUTO_ENROLL_USER_IDS: `${p.userId},${a.id}`, WALLET_AUTO_ENROLL_STUDIO_CAP: '2' };
    const out2 = events(await capture(() => expect(issueFirst(prisma, passes(), apple(), config, 'c')).rejects.toThrow(new Refusal('FIRST_ISSUE_GATE_FAILED'))));
    expect(out2.find((e) => e['event'] === 'wallet_staging_first_issue_gate')).toMatchObject({
      problems: expect.arrayContaining(['ALLOWLIST_IS_NOT_EXACTLY_THIS_MEMBER', 'CAP_IS_NOT_1', 'ALLOWLIST_NAMES_A_USER_WITH_AN_EXISTING_CREDENTIAL']),
    });

    // Auto-enrollment switched off: refused.
    allowExactlyC(p);
    liveOverrides['WALLET_AUTO_ENROLL_ENABLED'] = 'false';
    await capture(() => expect(issueFirst(prisma, passes(), apple(), config, 'c')).rejects.toThrow(new Refusal('FIRST_ISSUE_GATE_FAILED')));

    expect(await prisma.walletCredential.count()).toBe(credentialsBefore);
    expect(await fingerprints()).toEqual(before);
  });

  it('C’s first issue through WalletPassService.getBarcode is DYNAMIC with no registration; A and B stay byte-identical STATIC', async () => {
    await runSeed();
    const p = await prepared();
    const before = await fingerprints();
    allowExactlyC(p);

    const output = await runIssue();
    const ev = events(output);
    expect(ev.find((e) => e['event'] === 'wallet_staging_first_issue_gate')).toMatchObject({ passed: true, problems: [] });
    const issued = ev.find((e) => e['event'] === 'wallet_staging_first_issued') as Record<string, unknown>;
    expect(issued).toMatchObject({
      member: 'c',
      userId: p.userId,
      studioId: p.studioId,
      passMode: WalletPassMode.DYNAMIC,
      passVersion: 1,
      registrations: 0,
      webServiceUrlPresent: true,
      serialMatchesCredential: true,
      preExistingArtifacts: 2,
      preExistingArtifactsChanged: [],
    });

    const credential = await prisma.walletCredential.findFirstOrThrow({ where: { userId: p.userId } });
    expect(issued['walletCredentialId']).toBe(credential.id);
    const artifact = await prisma.walletPassArtifact.findUniqueOrThrow({
      where: { walletCredentialId_platform: { walletCredentialId: credential.id, platform: WalletPassPlatform.APPLE } },
      include: { _count: { select: { registrations: true } } },
    });
    expect(artifact.passMode).toBe(WalletPassMode.DYNAMIC);
    expect(artifact._count.registrations).toBe(0);
    const pass = (await extractPassJsonFromPkpass(Buffer.from(artifact.pkpassData!))) as { webServiceURL: string; serialNumber: string; authenticationToken: string };
    expect(pass.webServiceURL).toBe(DYNAMIC_WEB_SERVICE_URL);
    expect(pass.serialNumber).toBe(credential.id);
    // Never printed: the PassKit token or the QR value.
    const qr = await extractBarcodeMessageFromPkpass(Buffer.from(artifact.pkpassData!));
    expect(output).not.toContain(pass.authenticationToken);
    expect(output).not.toContain(qr.slice('gymos:v1:'.length));

    // A and B (previously issued STATIC passes) are byte-identical, and re-opening them with the
    // allowlist on keeps them STATIC (existing credentials are never auto-enrolled).
    const after = await fingerprints();
    expect(after.filter((f) => f.walletCredentialId !== credential.id)).toEqual(before);
    for (const email of ['sw-staging-a@staging.invalid', 'sw-staging-b@staging.invalid']) {
      const u = await prisma.user.findUniqueOrThrow({ where: { email } });
      await passes().getBarcode(p.studioId, u.id);
      await passes().getApplePass(p.studioId, u.id);
    }
    expect((await fingerprints()).filter((f) => f.walletCredentialId !== credential.id)).toEqual(before);

    // One-shot: a second issue and a second prepare both refuse and change nothing.
    await expect(issueFirst(prisma, passes(), apple(), config, 'c')).rejects.toThrow(new Refusal('FIRST_ISSUE_ALREADY_DONE'));
    await expect(prepareFirstIssue(prisma, 'c')).rejects.toThrow(new Refusal('FIRST_ISSUE_MEMBER_ALREADY_HAS_A_CREDENTIAL'));
    expect(await prisma.walletCredential.count({ where: { userId: p.userId } })).toBe(1);
  });

  it('status lists C with zero registrations; export --member c round-trips C’s dynamic bytes', async () => {
    await runSeed();
    const p = await prepared();
    const st0 = events(await capture(() => status(prisma))).at(-1)!['members'] as Array<Record<string, unknown>>;
    expect(st0.map((m) => [m['member'], m['walletCredentialId'] ?? null])).toEqual([
      ['a', expect.any(String)],
      ['b', expect.any(String)],
      ['c', null],
    ]);

    allowExactlyC(p);
    await runIssue();
    const st1 = events(await capture(() => status(prisma))).at(-1)!['members'] as Array<Record<string, unknown>>;
    expect(st1[2]).toMatchObject({ member: 'c', passMode: 'DYNAMIC', passVersion: 1, registrations: [] });
    expect(st1.slice(0, 2).map((m) => m['passMode'])).toEqual(['STATIC', 'STATIC']);

    const exported = await capture(() => exportPass(prisma, 'c'));
    const match = /-----BEGIN PKPASS-----\n([\s\S]*?)\n-----END PKPASS-----/.exec(exported);
    const credential = await prisma.walletCredential.findFirstOrThrow({ where: { userId: p.userId } });
    const stored = await prisma.walletPassArtifact.findUniqueOrThrow({
      where: { walletCredentialId_platform: { walletCredentialId: credential.id, platform: WalletPassPlatform.APPLE } },
    });
    expect(Buffer.from(match![1]!.replace(/\n/g, ''), 'base64').equals(Buffer.from(stored.pkpassData!))).toBe(true);
  });
});
