import type { PrismaClient } from '@prisma/client';

/**
 * Truncates all application tables (public schema) for isolated e2e runs.
 * Order is a single TRUNCATE … CASCADE so FKs are satisfied.
 */
export async function truncateAll(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "refresh_tokens",
      "stripe_webhook_events",
      "payments",
      "qr_tokens",
      "attendances",
      "waitlist_entries",
      "bookings",
      "scheduled_classes",
      "class_templates",
      "subscriptions",
      "membership_plans",
      "studio_memberships",
      "users",
      "studios"
    RESTART IDENTITY CASCADE;
  `);
}
