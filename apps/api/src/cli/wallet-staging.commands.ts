import { createHash, randomBytes } from 'node:crypto';
import { BillingInterval, Role, SubscriptionSource, SubscriptionStatus, WalletPassPlatform } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import type { PrismaService } from '../prisma/prisma.service';
import type { AppleWalletProvider } from '../wallet/apple/apple-wallet-provider.service';
import { extractBarcodeMessageFromPkpass } from '../wallet/apple/pkpass-reader';
import type { WalletPassService } from '../wallet/wallet-pass.service';

/**
 * Commands behind wallet-staging.cli.ts, kept separate so they can be exercised against the
 * isolated test database. The CLI entry point applies checkSmartWalletStagingTarget() before
 * calling any of these; nothing here may be wired into the API itself.
 */
export const STUDIO_SLUG = 'sw-staging';
const PLAN_NAME = 'Staging Full Access';
export const MEMBERS = {
  a: { email: 'sw-staging-a@staging.invalid', firstName: 'Staging', lastName: 'Uno' },
  b: { email: 'sw-staging-b@staging.invalid', firstName: 'Staging', lastName: 'Dos' },
} as const;
export type MemberLabel = keyof typeof MEMBERS;
const DAY = 24 * 60 * 60 * 1000;
/** A database with more than this many users is not the empty staging database. */
const MAX_USERS_IN_STAGING_DB = 10;

export class Refusal extends Error {}

export function out(event: string, data: Record<string, unknown>): void {
  // stdout carries only machine-readable results (and, for export, the pass payload).
  process.stdout.write(`${JSON.stringify({ event: `wallet_staging_${event}`, ...data })}\n`);
}

export function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function memberLabel(args: string[]): MemberLabel {
  const v = arg(args, '--member');
  if (v !== 'a' && v !== 'b') throw new Refusal('MEMBER_MUST_BE_a_OR_b');
  return v;
}

function hash12(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

async function qrFingerprint(pkpass: Uint8Array | null): Promise<string | null> {
  if (!pkpass) return null;
  try {
    return hash12(await extractBarcodeMessageFromPkpass(Buffer.from(pkpass)));
  } catch {
    return 'unreadable';
  }
}

async function findMember(prisma: PrismaService, label: MemberLabel) {
  const studio = await prisma.studio.findUnique({ where: { slug: STUDIO_SLUG }, select: { id: true } });
  const user = await prisma.user.findUnique({ where: { email: MEMBERS[label].email }, select: { id: true } });
  if (!studio || !user) throw new Refusal('NOT_SEEDED');
  const credential = await prisma.walletCredential.findFirst({
    where: { studioId: studio.id, userId: user.id, revokedAt: null },
    select: { id: true },
  });
  return { studioId: studio.id, userId: user.id, walletCredentialId: credential?.id ?? null };
}

export async function seed(prisma: PrismaService, passes: WalletPassService, apple: AppleWalletProvider): Promise<void> {
  if (!apple.isConfigured()) throw new Refusal('APPLE_SIGNING_NOT_CONFIGURED');

  // Only an empty database, or one holding nothing but this tool's own synthetic data.
  const foreignStudios = await prisma.studio.count({ where: { slug: { not: STUDIO_SLUG } } });
  const users = await prisma.user.count();
  if (foreignStudios > 0 || users > MAX_USERS_IN_STAGING_DB) throw new Refusal('DATABASE_IS_NOT_THE_EMPTY_STAGING_DATABASE');

  const studio =
    (await prisma.studio.findUnique({ where: { slug: STUDIO_SLUG } })) ??
    (await prisma.studio.create({
      data: { name: 'GymOS Wallet Staging', slug: STUDIO_SLUG, timezone: 'America/Mexico_City' },
    }));
  const plan =
    (await prisma.membershipPlan.findFirst({ where: { studioId: studio.id, name: PLAN_NAME } })) ??
    (await prisma.membershipPlan.create({
      data: {
        studioId: studio.id,
        name: PLAN_NAME,
        priceCents: 0,
        currency: 'mxn',
        billingInterval: BillingInterval.MONTHLY,
        allClassesAccess: true,
        openGymAccess: true,
        exclusiveGroup: 'CORE',
      },
    }));

  const now = Date.now();
  const results: Record<string, unknown>[] = [];
  for (const label of Object.keys(MEMBERS) as MemberLabel[]) {
    const m = MEMBERS[label];
    const user =
      (await prisma.user.findUnique({ where: { email: m.email } })) ??
      (await prisma.user.create({
        data: {
          email: m.email,
          firstName: m.firstName,
          lastName: m.lastName,
          // Nobody knows this password: the synthetic member never logs in.
          passwordHash: await bcrypt.hash(randomBytes(32).toString('base64url'), 10),
        },
      }));
    await prisma.studioMembership.upsert({
      where: { userId_studioId: { userId: user.id, studioId: studio.id } },
      create: { userId: user.id, studioId: studio.id, role: Role.MEMBER },
      update: {},
    });
    const existingSub = await prisma.subscription.findFirst({ where: { studioId: studio.id, userId: user.id } });
    if (!existingSub) {
      await prisma.subscription.create({
        data: {
          studioId: studio.id,
          userId: user.id,
          membershipPlanId: plan.id,
          status: SubscriptionStatus.ACTIVE,
          source: SubscriptionSource.CASH,
          currentPeriodStart: new Date(now - DAY),
          currentPeriodEnd: new Date(now + 29 * DAY),
          cancelAtPeriodEnd: true,
          exclusiveGroupKey: 'CORE',
          notes: 'Smart Wallet staging synthetic membership',
        },
      });
    }
    // Same path the member app uses: issues the credential once and provisions the STATIC
    // Apple pass while the raw value exists. The returned barcode is deliberately discarded.
    await passes.getBarcode(studio.id, user.id);

    const { walletCredentialId } = await findMember(prisma, label);
    const artifact = walletCredentialId
      ? await prisma.walletPassArtifact.findUnique({
          where: { walletCredentialId_platform: { walletCredentialId, platform: WalletPassPlatform.APPLE } },
          select: { passMode: true, templateVersion: true, pkpassData: true },
        })
      : null;
    if (!artifact?.pkpassData) throw new Error(`APPLE_ARTIFACT_NOT_CREATED_FOR_MEMBER_${label.toUpperCase()}`);
    results.push({
      member: label,
      userId: user.id,
      walletCredentialId,
      passMode: artifact.passMode,
      templateVersion: artifact.templateVersion,
      qrFingerprint: await qrFingerprint(artifact.pkpassData),
    });
  }
  out('seeded', { studioId: studio.id, planId: plan.id, members: results });
}

export async function setEntitlement(prisma: PrismaService, label: MemberLabel, state: string | undefined): Promise<void> {
  if (state !== 'active' && state !== 'expired') throw new Refusal('STATE_MUST_BE_active_OR_expired');
  const { studioId, userId } = await findMember(prisma, label);
  const sub = await prisma.subscription.findFirst({ where: { studioId, userId }, orderBy: { createdAt: 'asc' } });
  if (!sub) throw new Refusal('NO_SYNTHETIC_SUBSCRIPTION');
  const now = Date.now();
  const period =
    state === 'active'
      ? { currentPeriodStart: new Date(now - DAY), currentPeriodEnd: new Date(now + 29 * DAY) }
      : { currentPeriodStart: new Date(now - 31 * DAY), currentPeriodEnd: new Date(now - DAY) };
  await prisma.subscription.update({ where: { id: sub.id }, data: { ...period, status: SubscriptionStatus.ACTIVE } });
  out('entitlement_set', { member: label, state, subscriptionId: sub.id, ...period });
}

export async function exportPass(prisma: PrismaService, label: MemberLabel): Promise<void> {
  const { walletCredentialId } = await findMember(prisma, label);
  if (!walletCredentialId) throw new Refusal('NO_ACTIVE_CREDENTIAL');
  const artifact = await prisma.walletPassArtifact.findUnique({
    where: { walletCredentialId_platform: { walletCredentialId, platform: WalletPassPlatform.APPLE } },
    select: { pkpassData: true, passMode: true, passVersion: true },
  });
  if (!artifact?.pkpassData) throw new Refusal('NO_APPLE_PASS');
  const bytes = Buffer.from(artifact.pkpassData);
  process.stderr.write(
    `${JSON.stringify({
      event: 'wallet_staging_export',
      member: label,
      walletCredentialId,
      passMode: artifact.passMode,
      passVersion: artifact.passVersion,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      qrFingerprint: await qrFingerprint(artifact.pkpassData),
    })}\n`,
  );
  const wrapped = (bytes.toString('base64').match(/.{1,76}/g) ?? []).join('\n');
  process.stdout.write(`-----BEGIN PKPASS-----\n${wrapped}\n-----END PKPASS-----\n`);
}

export async function status(prisma: PrismaService): Promise<void> {
  const members: Record<string, unknown>[] = [];
  for (const label of Object.keys(MEMBERS) as MemberLabel[]) {
    let found: Awaited<ReturnType<typeof findMember>>;
    try {
      found = await findMember(prisma, label);
    } catch {
      members.push({ member: label, seeded: false });
      continue;
    }
    const artifact = found.walletCredentialId
      ? await prisma.walletPassArtifact.findUnique({
          where: { walletCredentialId_platform: { walletCredentialId: found.walletCredentialId, platform: WalletPassPlatform.APPLE } },
          select: {
            pkpassData: true,
            passMode: true,
            passVersion: true,
            templateVersion: true,
            dynamicTemplateVersion: true,
            lastModifiedAt: true,
            nextTransitionAt: true,
            registrations: { select: { deviceLibraryIdentifier: true, pushToken: true, createdAt: true, updatedAt: true }, orderBy: { createdAt: 'asc' } },
          },
        })
      : null;
    members.push({
      member: label,
      seeded: true,
      userId: found.userId,
      walletCredentialId: found.walletCredentialId,
      passMode: artifact?.passMode ?? null,
      passVersion: artifact?.passVersion ?? null,
      templateVersion: artifact?.templateVersion ?? null,
      dynamicTemplateVersion: artifact?.dynamicTemplateVersion ?? null,
      lastModifiedAt: artifact?.lastModifiedAt ?? null,
      nextTransitionAt: artifact?.nextTransitionAt ?? null,
      qrFingerprint: await qrFingerprint(artifact?.pkpassData ?? null),
      registrations: (artifact?.registrations ?? []).map((r) => ({
        device: hash12(r.deviceLibraryIdentifier),
        pushTokenLength: r.pushToken.length,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    });
  }
  out('status', { members });
}

