import { randomBytes } from 'node:crypto';
import type { Prisma, PrismaClient, Role } from '@prisma/client';
import { BillingInterval, ClassStatus, SubscriptionStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';

function bcryptRounds(): number {
  const n = Number.parseInt(process.env['BCRYPT_ROUNDS'] ?? '12', 10);
  return Number.isInteger(n) && n >= 4 && n <= 31 ? n : 12;
}

export async function createStudio(
  prisma: PrismaClient,
  data?: Partial<Prisma.StudioCreateInput>,
): Promise<{ id: string; slug: string }> {
  const suffix = randomBytes(4).toString('hex');
  const studio = await prisma.studio.create({
    data: {
      name: data?.name ?? `Studio ${suffix}`,
      slug: data?.slug ?? `st-${suffix}`,
      timezone: data?.timezone ?? 'UTC',
      ...data,
    },
    select: { id: true, slug: true },
  });
  return studio;
}

export async function createClassTemplate(
  prisma: PrismaClient,
  studioId: string,
  opts: {
    name?: string;
    durationMinutes?: number;
    defaultCapacity?: number;
    description?: string | null;
    deletedAt?: Date | null;
  } = {},
) {
  return prisma.classTemplate.create({
    data: {
      studioId,
      name: opts.name ?? 'Yoga',
      durationMinutes: opts.durationMinutes ?? 60,
      defaultCapacity: opts.defaultCapacity ?? 12,
      description: opts.description ?? null,
      deletedAt: opts.deletedAt ?? null,
    },
  });
}

export async function createScheduledClass(
  prisma: PrismaClient,
  studioId: string,
  templateId: string,
  opts: {
    startsAt?: Date;
    endsAt?: Date;
    capacity?: number;
    status?: ClassStatus;
    instructorId?: string | null;
  } = {},
) {
  const startsAt = opts.startsAt ?? new Date('2030-06-15T12:00:00.000Z');
  const endsAt = opts.endsAt ?? new Date('2030-06-15T13:00:00.000Z');
  return prisma.scheduledClass.create({
    data: {
      studioId,
      classTemplateId: templateId,
      capacity: opts.capacity ?? 10,
      status: opts.status ?? ClassStatus.SCHEDULED,
      startsAt,
      endsAt,
      instructorId: opts.instructorId ?? null,
    },
  });
}

export async function createMembershipPlanForStudio(prisma: PrismaClient, studioId: string) {
  return prisma.membershipPlan.create({
    data: {
      studioId,
      name: 'E2E Plan',
      priceCents: 1000,
      currency: 'usd',
      billingInterval: BillingInterval.MONTHLY,
      active: true,
    },
  });
}

export async function createActiveSubscription(
  prisma: PrismaClient,
  studioId: string,
  userId: string,
  membershipPlanId: string,
) {
  return prisma.subscription.create({
    data: {
      studioId,
      userId,
      membershipPlanId,
      status: SubscriptionStatus.ACTIVE,
    },
  });
}

export async function createUserWithPassword(
  prisma: PrismaClient,
  opts: {
    email?: string;
    password?: string;
    deletedAt?: Date | null;
  } = {},
): Promise<{ id: string; email: string; password: string }> {
  const password = opts.password ?? 'password12';
  const email = opts.email ?? `user_${randomBytes(6).toString('hex')}@e2e.local`;
  const passwordHash = await bcrypt.hash(password, bcryptRounds());
  const user = await prisma.user.create({
    data: {
      email,
      firstName: 'E2E',
      lastName: 'User',
      passwordHash,
      deletedAt: opts.deletedAt ?? null,
    },
    select: { id: true, email: true },
  });
  return { ...user, password };
}

export async function createMembership(
  prisma: PrismaClient,
  userId: string,
  studioId: string,
  role: Role,
  deletedAt?: Date | null,
) {
  return prisma.studioMembership.create({
    data: {
      userId,
      studioId,
      role,
      deletedAt: deletedAt ?? null,
    },
  });
}
