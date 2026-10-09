import { BillingAlertService } from './billing-alert.service';

/**
 * Flag parsing and alert privacy, in isolation. Production defaults: alerts OFF, HIGH threshold,
 * 24 h escalation, no channels. Anything malformed falls back to the safe default.
 */
describe('BillingAlertService — settings parsing', () => {
  const KEYS = ['BILLING_ALERTS_ENABLED', 'BILLING_ALERT_WEBHOOK_URL', 'BILLING_ALERT_EMAIL_TO', 'BILLING_ALERT_MIN_SEVERITY', 'BILLING_ALERT_ESCALATION_HOURS', 'BILLING_ALERT_ADMIN_BASE_URL', 'EMAIL_FROM_ADDRESS', 'EMAIL_FROM_NAME', 'EMAIL_PLATFORM_NAME'];
  const saved: Record<string, string | undefined> = {};
  const service = () => new BillingAlertService({} as never, {} as never, undefined);

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('defaults: disabled, no channels, HIGH, 24h, no links', () => {
    expect(service().settings()).toMatchObject({ enabled: false, webhookUrl: null, emailTo: [], minSeverity: 'HIGH', escalationHours: 24, adminBaseUrl: null });
  });

  it('only the exact string "true" enables alerts', () => {
    for (const v of ['TRUE', 'True', '1', 'yes', 'on', 'false', '']) {
      process.env['BILLING_ALERTS_ENABLED'] = v;
      expect(service().settings().enabled).toBe(false);
    }
    process.env['BILLING_ALERTS_ENABLED'] = 'true';
    expect(service().settings().enabled).toBe(true);
  });

  it('rejects non-https or unparsable webhook URLs (a pasted scheme-less Slack URL disables the channel)', () => {
    for (const v of ['hooks.slack.com/services/T0/B0/x', 'http://hooks.example.com/x', 'not a url', ' ']) {
      process.env['BILLING_ALERT_WEBHOOK_URL'] = v;
      expect(service().settings().webhookUrl).toBeNull();
    }
    process.env['BILLING_ALERT_WEBHOOK_URL'] = ' https://hooks.example.com/services/x ';
    expect(service().settings().webhookUrl).toBe('https://hooks.example.com/services/x');
  });

  it('parses recipients, severity and escalation with safe fallbacks', () => {
    process.env['BILLING_ALERT_EMAIL_TO'] = ' ops@example.com, , billing@example.com ';
    process.env['BILLING_ALERT_MIN_SEVERITY'] = 'medium';
    process.env['BILLING_ALERT_ESCALATION_HOURS'] = '6';
    process.env['BILLING_ALERT_ADMIN_BASE_URL'] = 'https://admin.example.com/';
    expect(service().settings()).toMatchObject({ emailTo: ['ops@example.com', 'billing@example.com'], minSeverity: 'MEDIUM', escalationHours: 6, adminBaseUrl: 'https://admin.example.com' });
    process.env['BILLING_ALERT_MIN_SEVERITY'] = 'URGENT';
    process.env['BILLING_ALERT_ESCALATION_HOURS'] = '-3';
    expect(service().settings()).toMatchObject({ minSeverity: 'HIGH', escalationHours: 24 });
    process.env['BILLING_ALERT_ESCALATION_HOURS'] = 'soon';
    expect(service().settings().escalationHours).toBe(24);
  });
});

describe('BillingAlertService — message privacy', () => {
  it('never puts an email address, card data or a raw payload into an alert', async () => {
    const prisma = {
      studio: { findUnique: jest.fn().mockResolvedValue({ name: 'Studio X' }) },
      user: { findUnique: jest.fn().mockResolvedValue({ firstName: 'Nombre', lastName: 'Apellido' }) },
    };
    const service = new BillingAlertService(prisma as never, {} as never, undefined);
    const row = {
      id: 'case_1', studioId: 'studio_1', userId: 'user_1', category: 'PAID_WITHOUT_ENTITLEMENT', severity: 'CRITICAL', status: 'OPEN', reasonCode: 'SUBSCRIPTION_ENDED',
      title: 'Pago recibido sin acceso: $1,500.00 de Full Access', summary: 'Stripe cobró una factura de una suscripción ya terminada.', suggestedAction: 'Decide con el miembro.',
      evidence: { customer_email: 'leak@example.com', card: '4242424242424242' }, history: [], firstDetectedAt: new Date('2026-10-09T07:00:00Z'), lastObservedAt: new Date('2026-10-09T07:00:00Z'),
      lastAlertedAt: null, alertCount: 0, escalatedAt: null,
    } as never;
    const msg = await service.buildMessage(row, true, { ...service.settings(), adminBaseUrl: 'https://admin.example.com' }, new Map());
    expect(msg.text).toMatch(/^\[ESCALACIÓN\] Pago recibido sin acceso/);
    expect(msg.text).toMatch(/Miembro: Nombre A\. \(user_1\)/);
    expect(msg.text).toMatch(/Ver en Admin: https:\/\/admin\.example\.com\/members\/user_1\?tab=billing/);
    for (const surface of [msg.text, msg.html, JSON.stringify(msg.payload), msg.subject]) {
      expect(surface).not.toContain('@');
      expect(surface).not.toContain('4242');
      expect(surface).not.toContain('Apellido');
    }
  });
});
