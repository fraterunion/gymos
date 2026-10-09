import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { validateEnv } from '../config/validate-env';
import { PrismaModule } from '../prisma/prisma.module';
import { BillingModule } from '../billing/billing.module';
import { BillingReconciliationRunService } from '../billing/reconciliation/billing-reconciliation-run.service';

/**
 * Nightly billing reconciliation entrypoint for the Railway cron service (replaces
 * scripts/billing-integrity-audit.ts once the cron command is switched — a release step).
 *
 *   node dist/cli/billing-reconciliation.cli.js [--studio <id>] [--no-alerts]
 *
 * Detection only: GET-only against Stripe, writes reconciliation cases/runs, never memberships,
 * payments or Stripe objects. Alerts are additionally gated by BILLING_ALERTS_ENABLED.
 * Exit codes: 0 completed (or intentionally disabled), 2 partial (a detector could not finish), 1 failed.
 */
/**
 * Deliberately NOT AppModule: no HTTP server, no NestSchedulerModule (so the API's own cron jobs
 * and pollers never start inside the cron container), no build-job workers. BillingModule pulls
 * in AuthModule transitively (enrollment/waiver), whose throttler guard needs the module options.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv, envFilePath: ['.env'] }),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 10_000, setHeaders: false }]),
    PrismaModule,
    BillingModule,
  ],
})
class BillingReconciliationCliModule {}

async function main(): Promise<number> {
  if (process.env['BILLING_RECONCILIATION_RUN_ENABLED'] === 'false') {
    // Intentionally disabled is not a failure: the cron must not page anyone for it.
    console.log(JSON.stringify({ event: 'billing_reconciliation_cli_disabled' }));
    return 0;
  }
  const args = process.argv.slice(2);
  const studioFlag = args.indexOf('--studio');
  const studioId = studioFlag >= 0 ? args[studioFlag + 1] ?? null : null;
  const dispatchAlerts = !args.includes('--no-alerts');

  const app = await NestFactory.createApplicationContext(BillingReconciliationCliModule, { logger: ['log', 'warn', 'error'] });
  try {
    const runs = app.get(BillingReconciliationRunService);
    const summary = studioId
      ? await runs.runStudio(studioId, 'CRON', { dispatchAlerts })
      : await runs.runAllStudios('CRON', { dispatchAlerts });
    console.log(JSON.stringify({ event: 'billing_reconciliation_cli_summary', ...summary }));
    return summary.status === 'COMPLETED' ? 0 : 2;
  } finally {
    await app.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(JSON.stringify({ event: 'billing_reconciliation_cli_failed', error: err instanceof Error ? err.message : String(err) }));
    process.exitCode = 1;
  });
