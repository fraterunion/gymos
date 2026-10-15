import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { validateEnv } from '../config/validate-env';
import { PrismaModule } from '../prisma/prisma.module';
import { WalletDiagnosticsService } from '../wallet/refresh/wallet-diagnostics.service';
import { WalletHealthService, walletHealthNeedsAttention } from '../wallet/refresh/wallet-health.service';
import { WalletModule } from '../wallet/wallet.module';

/**
 * Smart Wallet 2.0 Stage 3 — READ-ONLY diagnostics for lost or stale Wallet registrations.
 * Writes nothing, contacts nothing outside the database.
 *
 *   node dist/cli/wallet-diagnostics.cli.js pass --credential <walletCredentialId>
 *   node dist/cli/wallet-diagnostics.cli.js studio --studio <studioId>
 *   node dist/cli/wallet-diagnostics.cli.js certificate
 *   node dist/cli/wallet-diagnostics.cli.js health [--studio <studioId>]
 *
 *   pass         one pass: versions (current vs pushed), active registrations as {device hash,
 *                push-token length, timestamps}, last registration / unregistration / APNs
 *                acceptance / retrieval, churn and stale-version findings, recent events and jobs.
 *   studio       every dynamic pass of a studio with the same signals, plus the queue state.
 *   certificate  the pass signing certificate's identifiers, validity window and expiry level.
 *   health       operational findings (dead letters, refresh-failure spikes, APNs failures, passes
 *                with no active update registration, undelivered versions, devices that did not
 *                fetch after an accepted push, queue backlog, stuck jobs, idle worker, certificate).
 *                Exit code 3 when any finding is HIGH or CRITICAL (for a cron), 0 otherwise.
 *
 * Zero registrations is reported as "no active registration", never as "pass removed".
 * Never prints a device library identifier, push token, authentication token or QR value.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv, envFilePath: ['.env'] }),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 10_000, setHeaders: false }]),
    PrismaModule,
    WalletModule,
  ],
})
class WalletDiagnosticsCliModule {}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function print(event: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: `wallet_diagnostics_${event}`, ...data }));
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const command = args[0];
  const credential = flag(args, '--credential');
  const studio = flag(args, '--studio');
  const valid =
    (command === 'pass' && credential !== undefined && ID_PATTERN.test(credential)) ||
    (command === 'studio' && studio !== undefined && ID_PATTERN.test(studio)) ||
    (command === 'health' && (studio === undefined || ID_PATTERN.test(studio))) ||
    command === 'certificate';
  if (!valid) {
    print('usage', { usage: 'wallet-diagnostics.cli <pass --credential <id> | studio --studio <id> | certificate | health [--studio <id>]>' });
    return 1;
  }

  const app = await NestFactory.createApplicationContext(WalletDiagnosticsCliModule, { logger: ['warn', 'error'] });
  try {
    const diagnostics = app.get(WalletDiagnosticsService);
    const now = new Date();
    if (command === 'pass') print('pass', await diagnostics.passReport(credential!));
    else if (command === 'studio') print('studio', await diagnostics.studioReport(studio!, now));
    else if (command === 'health') {
      const report = await app.get(WalletHealthService).evaluate(now, { studioId: studio });
      print('health', report);
      return walletHealthNeedsAttention(report) ? 3 : 0;
    } else print('certificate', diagnostics.certificateReport(now));
    return 0;
  } finally {
    await app.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(JSON.stringify({ event: 'wallet_diagnostics_failed', error: err instanceof Error ? err.message : String(err) }));
    process.exitCode = 1;
  });
