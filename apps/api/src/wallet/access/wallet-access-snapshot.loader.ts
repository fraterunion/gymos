import { Injectable } from '@nestjs/common';
import { DayPassStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  computeWalletAccessSnapshot,
  type WalletAccessInput,
  type WalletAccessSnapshot,
  type WalletAccessSubscriptionInput,
} from './wallet-access-snapshot';

const SUBSCRIPTION_SELECT = {
  id: true,
  status: true,
  source: true,
  currentPeriodStart: true,
  currentPeriodEnd: true,
  entitlementEndsAt: true,
  cancelAtPeriodEnd: true,
  exclusiveGroupKey: true,
  supersededBySubscriptionId: true,
  endReason: true,
  createdAt: true,
  membershipPlan: {
    select: {
      id: true,
      name: true,
      classCredits: true,
      allClassesAccess: true,
      entitlementDays: true,
      openGymAccess: true,
      openGymWindowStart: true,
      openGymWindowEnd: true,
    },
  },
} satisfies Prisma.SubscriptionSelect;

type SubscriptionRow = Prisma.SubscriptionGetPayload<{ select: typeof SUBSCRIPTION_SELECT }>;

function toSubscriptionInput(row: SubscriptionRow): WalletAccessSubscriptionInput {
  const { membershipPlan, ...rest } = row;
  return { ...rest, plan: membershipPlan };
}

/**
 * Local midnight is never more than ~38h before "now" in any IANA zone (UTC-12..UTC+14), so a
 * 48h lookback always includes every pass for studio-local today; the pure snapshot drops the
 * past ones by studio-local date key.
 */
const DAY_PASS_LOOKBACK_MS = 48 * 60 * 60 * 1000;

export type WalletAccessCredentialRef = {
  id: string;
  studioId: string;
  userId: string;
  revokedAt: Date | null;
};

/**
 * Read-only Prisma loader for WalletAccessSnapshot. Every query is scoped by (studioId, userId)
 * taken from the WalletCredential row itself — never from request input — so a snapshot can only
 * ever describe the credential's own member in the credential's own studio.
 *
 * Plain reads, no transaction: the snapshot is presentation data, and a pass built from a read
 * that races a write is corrected by the next update.
 */
@Injectable()
export class WalletAccessSnapshotLoader {
  constructor(private readonly prisma: PrismaService) {}

  /** Every subscription row of this member in this studio, newest first, as snapshot input. */
  async loadSubscriptions(studioId: string, userId: string): Promise<WalletAccessSubscriptionInput[]> {
    const rows = await this.prisma.subscription.findMany({
      where: { studioId, userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      select: SUBSCRIPTION_SELECT,
    });
    return rows.map(toSubscriptionInput);
  }

  async loadInput(credential: WalletAccessCredentialRef, now: Date): Promise<WalletAccessInput> {
    const { studioId, userId } = credential;
    const [studio, user, membership, subscriptions, dayPasses] = await Promise.all([
      this.prisma.studio.findUniqueOrThrow({ where: { id: studioId }, select: { id: true, timezone: true } }),
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { firstName: true, lastName: true, deletedAt: true },
      }),
      this.prisma.studioMembership.findFirst({
        where: { studioId, userId, deletedAt: null },
        select: { id: true },
      }),
      this.loadSubscriptions(studioId, userId),
      this.prisma.dayPass.findMany({
        where: {
          studioId,
          userId,
          status: DayPassStatus.ACTIVE,
          validForDate: { gte: new Date(now.getTime() - DAY_PASS_LOOKBACK_MS) },
        },
        orderBy: [{ validForDate: 'asc' }, { id: 'asc' }],
        select: { id: true, status: true, validForDate: true },
      }),
    ]);

    return {
      studio: { id: studio.id, timezone: studio.timezone },
      member: { userId, firstName: user.firstName, lastName: user.lastName },
      credential: { id: credential.id, revokedAt: credential.revokedAt },
      // Mirrors pass-issuance eligibility (WalletPassService.resolveIssuableCredential).
      studioMembershipActive: membership !== null && user.deletedAt === null,
      subscriptions,
      dayPasses,
    };
  }

  async compute(credential: WalletAccessCredentialRef, now: Date): Promise<WalletAccessSnapshot> {
    return computeWalletAccessSnapshot(await this.loadInput(credential, now), now);
  }
}
