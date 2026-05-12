import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { markStripeWebhookEventProcessed, tryClaimStripeWebhookEvent } from './stripe-webhook-idempotency';

type Row = { stripeEventId: string; processed: boolean; payload: unknown };

function asPrismaService(mock: ReturnType<typeof createMockPrisma>): PrismaService {
  return mock as unknown as PrismaService;
}

function createMockPrisma(store = new Map<string, Row>()) {
  return {
    stripeWebhookEvent: {
      create: jest.fn(
        async ({
          data,
        }: {
          data: { stripeEventId: string; eventType: string; payload: unknown; processed: boolean };
        }) => {
        if (store.has(data.stripeEventId)) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'jest',
          });
        }
        store.set(data.stripeEventId, {
          stripeEventId: data.stripeEventId,
          processed: false,
          payload: data.payload,
        });
      }),
      findUnique: jest.fn(async ({ where }: { where: { stripeEventId: string } }) => {
        return store.get(where.stripeEventId) ?? null;
      }),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { stripeEventId: string; processed: boolean };
          data: { processed: boolean; processedAt: Date };
        }) => {
          const row = store.get(where.stripeEventId);
          if (row && where.processed === false && !row.processed) {
            row.processed = data.processed;
          }
          return { count: row ? 1 : 0 };
        },
      ),
    },
  };
}

describe('tryClaimStripeWebhookEvent', () => {
  it('returns true on first claim', async () => {
    const prisma = createMockPrisma();
    const ok = await tryClaimStripeWebhookEvent(asPrismaService(prisma), {
      id: 'evt_1',
      type: 'checkout.session.completed',
      payload: { x: 1 },
    });
    expect(ok).toBe(true);
  });

  it('returns false when event already processed', async () => {
    const prisma = createMockPrisma();
    await tryClaimStripeWebhookEvent(asPrismaService(prisma), {
      id: 'evt_dup',
      type: 'ping',
      payload: {},
    });
    await markStripeWebhookEventProcessed(asPrismaService(prisma), 'evt_dup');
    const ok = await tryClaimStripeWebhookEvent(asPrismaService(prisma), {
      id: 'evt_dup',
      type: 'ping',
      payload: {},
    });
    expect(ok).toBe(false);
  });

  it('returns true on duplicate id when not yet processed (Stripe retry)', async () => {
    const store = new Map<string, Row>();
    const prismaA = createMockPrisma(store);
    await tryClaimStripeWebhookEvent(asPrismaService(prismaA), {
      id: 'evt_retry',
      type: 'ping',
      payload: {},
    });
    const prismaB = createMockPrisma(store);
    const ok = await tryClaimStripeWebhookEvent(asPrismaService(prismaB), {
      id: 'evt_retry',
      type: 'ping',
      payload: {},
    });
    expect(ok).toBe(true);
  });
});
