import { EnrollmentFeeStatus, WaivedReason } from '@prisma/client';
import { EnrollmentService } from './enrollment.service';

// ──────────────────────────────────────────────────────────────────────────────
// Mock builder
// ──────────────────────────────────────────────────────────────────────────────

function buildTx(overrides: {
  existingEnrollment?: { status: EnrollmentFeeStatus } | null;
  totalFinalized?: number;
  waivedCount?: number;
  founderCount?: number;
  campaignLimit?: number;
}) {
  return {
    memberEnrollment: {
      findUnique: jest.fn().mockResolvedValue(overrides.existingEnrollment ?? null),
      count: jest
        .fn()
        // First call: totalFinalized (PAID + WAIVED count)
        .mockResolvedValueOnce(overrides.totalFinalized ?? 0)
        // Second call: waivedCount (slot availability check — only when wasPromoCandidate)
        .mockResolvedValueOnce(overrides.waivedCount ?? 0)
        // Third call: founderCount (sequential FIRST_N_PROMO waivers)
        .mockResolvedValueOnce(overrides.founderCount ?? 0),
      upsert: jest.fn().mockResolvedValue({}),
    },
    studioEnrollmentSettings: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        id: 'settings-1',
        studioId: 'studio-1',
        campaignLimit: overrides.campaignLimit ?? 50,
        campaignEnabled: true,
      }),
    },
  };
}

function buildService(txOverrides: Parameters<typeof buildTx>[0] = {}) {
  const tx = buildTx(txOverrides);
  const prisma = {
    $transaction: jest.fn().mockImplementation(
      async (fn: (tx: typeof tx) => Promise<void>, _opts?: unknown) => fn(tx),
    ),
  };
  const stripe = {
    createProductForPlan: jest.fn(),
    createOneTimePrice: jest.fn(),
    createBillingPortalSession: jest.fn(),
    createCheckoutSession: jest.fn(),
  };

  return {
    service: new EnrollmentService(prisma as never, stripe as never),
    prisma,
    stripe,
    tx,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Shared params
// ──────────────────────────────────────────────────────────────────────────────

const BASE_PARAMS = {
  userId: 'cmqzsizk9004rqo0rtq4hvgvm',
  studioId: 'studio-1',
  settingsId: 'cmqujjpo00008qg0rz2b39azh',
  stripeCheckoutSessionId: 'cs_live_carlo_recovery',
  wasPromoCandidate: true,
};

// ──────────────────────────────────────────────────────────────────────────────
// Tests 5-7: finalizeEnrollment — Carlo recovery regression suite
// ──────────────────────────────────────────────────────────────────────────────

describe('EnrollmentService.finalizeEnrollment — Carlo recovery regression suite', () => {
  // Test 5: idempotency — existing WAIVED enrollment short-circuits
  it('returns without mutation when enrollment already has status WAIVED', async () => {
    const { service, tx } = buildService({
      existingEnrollment: { status: EnrollmentFeeStatus.WAIVED },
    });

    await service.finalizeEnrollment(BASE_PARAMS);

    expect(tx.memberEnrollment.upsert).not.toHaveBeenCalled();
    expect(tx.studioEnrollmentSettings.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  // Test 5b: idempotency — existing PAID enrollment short-circuits
  it('returns without mutation when enrollment already has status PAID', async () => {
    const { service, tx } = buildService({
      existingEnrollment: { status: EnrollmentFeeStatus.PAID },
    });

    await service.finalizeEnrollment({ ...BASE_PARAMS, wasPromoCandidate: false });

    expect(tx.memberEnrollment.upsert).not.toHaveBeenCalled();
  });

  // Test 6: no Stripe mutation — finalizeEnrollment never calls stripe.*
  it('never calls any Stripe method during enrollment finalization', async () => {
    const { service, stripe } = buildService({
      existingEnrollment: null,
      totalFinalized: 10,
      waivedCount: 10,
      founderCount: 10,
      campaignLimit: 50,
    });

    await service.finalizeEnrollment(BASE_PARAMS);

    expect(stripe.createProductForPlan).not.toHaveBeenCalled();
    expect(stripe.createOneTimePrice).not.toHaveBeenCalled();
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
    expect(stripe.createBillingPortalSession).not.toHaveBeenCalled();
  });

  // Test 7: FIRST_N promo accounting — founderNumber = founderCount + 1
  it('assigns founderNumber = founderCount + 1 and waivedReason = FIRST_N_PROMO when slot is available', async () => {
    const { service, tx } = buildService({
      existingEnrollment: null,
      totalFinalized: 10,  // memberNumber = 11
      waivedCount: 10,     // < campaignLimit(50), slot available
      founderCount: 10,    // founderNumber = 11
      campaignLimit: 50,
    });

    await service.finalizeEnrollment(BASE_PARAMS);

    expect(tx.memberEnrollment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: EnrollmentFeeStatus.WAIVED,
          waivedReason: WaivedReason.FIRST_N_PROMO,
          memberNumber: 11,
          founderNumber: 11,
          stripeCheckoutSessionId: BASE_PARAMS.stripeCheckoutSessionId,
        }),
        update: expect.objectContaining({
          status: EnrollmentFeeStatus.WAIVED,
          waivedReason: WaivedReason.FIRST_N_PROMO,
          memberNumber: 11,
          founderNumber: 11,
        }),
      }),
    );
  });

  // Test 7b: FIRST_N promo overflow — slots ran out, waivedReason = FIRST_N_PROMO_OVERFLOW
  it('assigns waivedReason = FIRST_N_PROMO_OVERFLOW when campaign slots ran out between checkout and payment', async () => {
    const { service, tx } = buildService({
      existingEnrollment: null,
      totalFinalized: 50,
      waivedCount: 50,  // == campaignLimit(50), no slot
      founderCount: 50,
      campaignLimit: 50,
    });

    await service.finalizeEnrollment(BASE_PARAMS);

    expect(tx.memberEnrollment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: EnrollmentFeeStatus.WAIVED,
          waivedReason: WaivedReason.FIRST_N_PROMO_OVERFLOW,
          founderNumber: null,
        }),
      }),
    );
  });
});
