import 'reflect-metadata';

if (!process.env['DATABASE_URL']?.trim()) {
  throw new Error('DATABASE_URL must be set for e2e tests (use a dedicated PostgreSQL database).');
}

/** Disables rate limits so e2e suites can perform many logins without 429. */
process.env['GYMOS_E2E'] = '1';

if (!process.env['JWT_SECRET']?.trim()) {
  process.env['JWT_SECRET'] = 'e2e-test-jwt-secret-min-32-chars!!';
}

if (!process.env['JWT_QR_SECRET']?.trim()) {
  process.env['JWT_QR_SECRET'] = 'e2e-test-jwt-qr-secret-min-32-chars!!';
}

/** Must match `validate-env` defaults so `StripeService` mock and `ConfigService` use the same webhook secret. */
if (!process.env['STRIPE_SECRET_KEY']?.trim()) {
  process.env['STRIPE_SECRET_KEY'] = 'sk_test_REPLACE_ME';
}
if (!process.env['STRIPE_WEBHOOK_SECRET']?.trim()) {
  process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_test_gymos_default_value_for_signature_tests_00001';
}
if (!process.env['STRIPE_SUCCESS_URL']?.trim()) {
  process.env['STRIPE_SUCCESS_URL'] = 'http://localhost:3000/billing/success';
}
if (!process.env['STRIPE_CANCEL_URL']?.trim()) {
  process.env['STRIPE_CANCEL_URL'] = 'http://localhost:3000/billing/cancel';
}
if (!process.env['STRIPE_BILLING_PORTAL_RETURN_URL']?.trim()) {
  process.env['STRIPE_BILLING_PORTAL_RETURN_URL'] = 'http://localhost:3000/billing/portal-return';
}
