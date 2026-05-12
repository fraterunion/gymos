import { randomBytes } from 'node:crypto';
import type { Prisma, PrismaClient, Role } from '@prisma/client';
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
