import { createHash } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service';

export function expoWebhookDeliveryKey(rawBody: Buffer): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

/**
 * @returns true if this delivery should be processed; false if duplicate (already recorded).
 */
export async function tryClaimExpoWebhookDelivery(
  prisma: PrismaService,
  params: { deliveryKey: string; expoBuildId: string },
): Promise<boolean> {
  try {
    await prisma.expoWebhookDelivery.create({
      data: {
        deliveryKey: params.deliveryKey,
        expoBuildId: params.expoBuildId,
        processed: true,
      },
    });
    return true;
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === 'P2002') {
      return false;
    }
    throw e;
  }
}
