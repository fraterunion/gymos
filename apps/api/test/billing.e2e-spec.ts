import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role } from '@prisma/client';
import request from 'supertest';
import Stripe from 'stripe';
import { PrismaService } from '../src/prisma/prisma.service';
import { StripeService } from '../src/stripe/stripe.service';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import {
  createMembership,
  createMembershipPlanForStudio,
  createStudio,
  createUserWithPassword,
} from './helpers/factories';

async function loginAccessToken(
  app: INestApplication,
  email: string,
  password: string,
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password })
    .expect(201);
  return (res.body as { accessToken: string }).accessToken;
}

function signedStripeWebhookPayload(payload: object, secret: string): { payloadString: string; header: string } {
  const payloadString = JSON.stringify(payload);
  const header = Stripe.webhooks.generateTestHeaderString({
    payload: payloadString,
    secret,
  });
  return { payloadString, header };
}

describe('Billing / Stripe (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let webhookSecret: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    webhookSecret = app.get(ConfigService).getOrThrow<string>('STRIPE_WEBHOOK_SECRET');
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 403 when non-MEMBER calls membership plan checkout', async () => {
    const studio = await createStudio(prisma);
    const plan = await createMembershipPlanForStudio(prisma, studio.id);
    const { id: userId, email, password } = await createUserWithPassword(prisma, {
      email: 'owner-bill@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, userId, studio.id, Role.OWNER);
    const token = await loginAccessToken(app, email, password);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/membership-plans/${plan.id}/checkout`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('returns checkout URL for MEMBER', async () => {
    const studio = await createStudio(prisma);
    const plan = await createMembershipPlanForStudio(prisma, studio.id);
    const { id: userId, email, password } = await createUserWithPassword(prisma, {
      email: 'member-bill@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, userId, studio.id, Role.MEMBER);
    const token = await loginAccessToken(app, email, password);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/membership-plans/${plan.id}/checkout`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect((res.body as { url: string }).url).toContain('stripe.com');
  });

  it('returns 400 for billing portal without Stripe customer', async () => {
    const studio = await createStudio(prisma);
    const { id: userId, email, password } = await createUserWithPassword(prisma, {
      email: 'no-cus@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, userId, studio.id, Role.MEMBER);
    const token = await loginAccessToken(app, email, password);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/billing-portal`)
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });

  it('returns billing portal URL when user has stripeCustomerId', async () => {
    const studio = await createStudio(prisma);
    const { id: userId, email, password } = await createUserWithPassword(prisma, {
      email: 'with-cus@e2e.local',
      password: 'password12',
    });
    await prisma.user.update({
      where: { id: userId },
      data: { stripeCustomerId: 'cus_e2e_test_customer' },
    });
    await createMembership(prisma, userId, studio.id, Role.MEMBER);
    const token = await loginAccessToken(app, email, password);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/billing-portal`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect((res.body as { url: string }).url).toContain('stripe.com');
  });

  it('creates subscription from checkout.session.completed webhook', async () => {
    const studio = await createStudio(prisma);
    const plan = await createMembershipPlanForStudio(prisma, studio.id);
    const { id: userId, email, password } = await createUserWithPassword(prisma, {
      email: 'webhook-mem@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, userId, studio.id, Role.MEMBER);
    const token = await loginAccessToken(app, email, password);
    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/membership-plans/${plan.id}/checkout`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const stripeSvc = app.get(StripeService) as {
      retrieveSubscription: jest.Mock;
    };
    const now = Math.floor(Date.now() / 1000);
    stripeSvc.retrieveSubscription.mockResolvedValueOnce({
      id: 'sub_webhook_e2e_1',
      object: 'subscription',
      customer: 'cus_e2e_test_customer',
      status: 'active',
      current_period_start: now,
      current_period_end: now + 86_400 * 30,
      cancel_at_period_end: false,
      metadata: {
        userId,
        studioId: studio.id,
        planId: plan.id,
      },
    });

    const event = {
      id: 'evt_checkout_completed_e2e_1',
      object: 'event',
      api_version: '2025-08-27.basil',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_webhook_e2e_1',
          object: 'checkout.session',
          mode: 'subscription',
          payment_status: 'paid',
          subscription: 'sub_webhook_e2e_1',
          metadata: {
            userId,
            studioId: studio.id,
            planId: plan.id,
          },
        },
      },
    };

    const { payloadString, header } = signedStripeWebhookPayload(event, webhookSecret);

    await request(app.getHttpServer())
      .post('/api/v1/stripe/webhook')
      .set('Stripe-Signature', header)
      .set('Content-Type', 'application/json')
      .send(payloadString)
      .expect(200);

    const sub = await prisma.subscription.findUnique({
      where: { stripeSubscriptionId: 'sub_webhook_e2e_1' },
    });
    expect(sub).not.toBeNull();
    expect(sub?.userId).toBe(userId);
    expect(sub?.membershipPlanId).toBe(plan.id);
  });

  it('dedupes identical webhook deliveries via StripeWebhookEvent', async () => {
    const studio = await createStudio(prisma);
    const plan = await createMembershipPlanForStudio(prisma, studio.id);
    const { id: userId } = await createUserWithPassword(prisma, {
      email: 'dedupe@e2e.local',
      password: 'password12',
    });
    await prisma.user.update({
      where: { id: userId },
      data: { stripeCustomerId: 'cus_e2e_test_customer' },
    });
    await createMembership(prisma, userId, studio.id, Role.MEMBER);

    const stripeSvc = app.get(StripeService) as {
      retrieveSubscription: jest.Mock;
    };
    const now = Math.floor(Date.now() / 1000);
    stripeSvc.retrieveSubscription.mockResolvedValue({
      id: 'sub_webhook_e2e_dup',
      object: 'subscription',
      customer: 'cus_e2e_test_customer',
      status: 'active',
      current_period_start: now,
      current_period_end: now + 86_400 * 30,
      cancel_at_period_end: false,
      metadata: {
        userId,
        studioId: studio.id,
        planId: plan.id,
      },
    });

    const event = {
      id: 'evt_dedupe_webhook_1',
      object: 'event',
      api_version: '2025-08-27.basil',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_dedupe_1',
          object: 'checkout.session',
          mode: 'subscription',
          payment_status: 'paid',
          subscription: 'sub_webhook_e2e_dup',
          metadata: {
            userId,
            studioId: studio.id,
            planId: plan.id,
          },
        },
      },
    };

    const { payloadString, header } = signedStripeWebhookPayload(event, webhookSecret);

    await request(app.getHttpServer())
      .post('/api/v1/stripe/webhook')
      .set('Stripe-Signature', header)
      .set('Content-Type', 'application/json')
      .send(payloadString)
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/stripe/webhook')
      .set('Stripe-Signature', header)
      .set('Content-Type', 'application/json')
      .send(payloadString)
      .expect(200);

    const rows = await prisma.subscription.findMany({
      where: { stripeSubscriptionId: 'sub_webhook_e2e_dup' },
    });
    expect(rows).toHaveLength(1);
  });
});
