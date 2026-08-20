import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoFile = (path: string) => readFileSync(resolve(process.cwd(), '../..', path), 'utf8');

describe('Basic Access MXN 1,300 price contract', () => {
  it('uses a guarded idempotent migration without changing the Stripe Price', () => {
    const sql = repoFile('apps/api/prisma/migrations/20260820030000_basic_access_price_sync/migration.sql');
    expect(sql).toContain('SET "price_cents" = 130000');
    expect(sql).toContain("\"id\" = 'cmq1y1sqe000xenswkzsfwq28'");
    expect(sql).toContain("\"name\" = 'Basic Access'");
    expect(sql).toContain("\"stripe_price_id\" = 'price_1TiPaiGuUoCXNOREdIeDGSgc'");
    expect(sql).toContain('"price_cents" = 100000');
    expect(sql).not.toMatch(/SET\s+"stripe_price_id"/);
  });

  it.each([
    'apps/api/prisma/seed.ts',
    'apps/api/prisma/seed-ares-production.ts',
  ])('%s seeds Basic Access at 130000 cents', (file) => {
    const source = repoFile(file);
    const basicBlock = source.slice(source.indexOf("name: 'Basic Access'"), source.indexOf("name: 'Basic Access'") + 500);
    expect(basicBlock).toContain('priceCents: 130000');
  });

  it('Admin membership catalog renders the API plan price', () => {
    expect(repoFile('apps/admin/src/app/memberships/page.tsx')).toContain('formatCents(plan.priceCents, plan.currency)');
  });

  it('Admin member profile and plan-change choices render the API plan price', () => {
    const source = repoFile('apps/admin/src/app/members/[userId]/page.tsx');
    expect(source).toContain('fmtPlanPrice(plan.priceCents, plan.currency, plan.billingInterval)');
    expect(source).toContain('currentSubscription.membershipPlan.priceCents');
  });

  it('Mobile catalog and purchase preview render the API plan price', () => {
    const source = repoFile('apps/mobile/app/(app)/(tabs)/membership.tsx');
    expect(source).toContain('formatMoneyFromCents(plan.priceCents, plan.currency)');
    expect(source).toContain('plan.priceCents + preview.enrollmentFeeCents');
  });

  it('Staff sales renders and submits the API plan price', () => {
    const source = repoFile('apps/mobile/app/(app)/staff-sales/index.tsx');
    expect(source).toContain('formatMoneyFromCents(plan.priceCents, plan.currency)');
    expect(source).toContain('amountCents: selectedPlan.priceCents');
  });
});
