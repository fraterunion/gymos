import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Stripe may deliver the same event more than once. We record `stripe_event_id`
 * first; only the first claim (or an unprocessed retry) proceeds to handlers.
 *
 * Each successful claim increments `attemptCount` and sets `lastAttemptAt`.
 * Rows with `processed=false` after multiple retries are "dead letters" detected
 * by SubscriptionReconciliationService.
 *
 * @returns whether handlers should run and `markStripeWebhookEventProcessed` should be called.
 */
export async function tryClaimStripeWebhookEvent(
  prisma: PrismaService,
  event: { id: string; type: string; payload: Prisma.InputJsonValue },
): Promise<boolean> {
  const now = new Date();
  try {
    await prisma.stripeWebhookEvent.create({
      data: {
        stripeEventId: event.id,
        eventType: event.type,
        payload: event.payload,
        processed: false,
        attemptCount: 1,
        lastAttemptAt: now,
      },
    });
    return true;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const row = await prisma.stripeWebhookEvent.findUnique({
        where: { stripeEventId: event.id },
      });
      if (row?.processed) {
        return false;
      }
      // Increment attempt count on Stripe retry
      await prisma.stripeWebhookEvent.update({
        where: { stripeEventId: event.id },
        data: {
          attemptCount: { increment: 1 },
          lastAttemptAt: now,
        },
      });
      return true;
    }
    throw e;
  }
}

export async function markStripeWebhookEventProcessed(
  prisma: PrismaService,
  eventId: string,
): Promise<void> {
  await prisma.stripeWebhookEvent.updateMany({
    where: { stripeEventId: eventId, processed: false },
    data: { processed: true, processedAt: new Date() },
  });
}
