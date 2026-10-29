import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSafeRehearsalQaTarget,
  REHEARSAL_ENVIRONMENT_ID,
} from './provision-pr5-qa.mjs';

const good = {
  RAILWAY_ENVIRONMENT_ID: REHEARSAL_ENVIRONMENT_ID,
  ARES_PR5_QA_PROVISION: 'I_AUTHORIZE_ISOLATED_QA_FIXTURE',
  DATABASE_URL: 'postgresql://qa:secret@postgres-rehearsal.railway.internal:5432/railway',
  MIGRATION_DATABASE_URL: 'postgresql://qa:secret@postgres-rehearsal.railway.internal:5432/railway',
  STRIPE_SECRET_KEY: 'sk_test_purely_local_dummy_never_sent',
  EMAIL_CAMPAIGN_WORKER: '0',
  ARES_QA_OWNER_PASSWORD: 'fake-owner-secret-for-guard-tests',
  ARES_QA_FRONT_DESK_PASSWORD: 'fake-reception-secret-for-tests',
  ARES_QA_MEMBER_PASSWORD: 'fake-member-secret-for-guard-tests',
};

test('only the exact rehearsal DB + Stripe TEST + opt-in pass', () => {
  assert.doesNotThrow(() => assertSafeRehearsalQaTarget(good));
});
for (const [label, patch] of [
  ['wrong environment', { RAILWAY_ENVIRONMENT_ID: 'production' }],
  ['missing consent', { ARES_PR5_QA_PROVISION: undefined }],
  ['production DB', { DATABASE_URL: 'postgresql://qa:secret@production.internal:5432/railway' }],
  ['mismatched migrations', { MIGRATION_DATABASE_URL: 'postgresql://qa:secret@production.internal:5432/railway' }],
  ['wrong database name', { DATABASE_URL: 'postgresql://qa:secret@postgres-rehearsal.railway.internal:5432/prod' }],
  ['live Stripe', { STRIPE_SECRET_KEY: 'sk_live_dummy' }],
  ['enabled campaigns', { EMAIL_CAMPAIGN_WORKER: '1' }],
  ['missing owner password', { ARES_QA_OWNER_PASSWORD: undefined }],
  ['short password', { ARES_QA_MEMBER_PASSWORD: 'short' }],
  ['reused password', { ARES_QA_FRONT_DESK_PASSWORD: good.ARES_QA_OWNER_PASSWORD }],
]) {
  test(`rejects ${label} before any DB write`, () => {
    assert.throws(() => assertSafeRehearsalQaTarget({ ...good, ...patch }), /QA fixture blocked/);
  });
}
