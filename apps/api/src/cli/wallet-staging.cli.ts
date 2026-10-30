import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { validateEnv } from '../config/validate-env';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { AppleWalletProvider } from '../wallet/apple/apple-wallet-provider.service';
import { WalletPassService } from '../wallet/wallet-pass.service';
import { WalletModule } from '../wallet/wallet.module';
import { checkSmartWalletStagingTarget } from './staging-guard';
import { arg, exportPass, firstIssueLabel, issueFirst, memberLabel, out, prepareFirstIssue, Refusal, seed, setEntitlement, status } from './wallet-staging.commands';

/**
 * Smart Wallet 2.0 Stage 2 — STAGING-ONLY operator tool for the real-iPhone proof. It refuses to
 * run anywhere but the `smart-wallet-staging` Railway environment against a Railway-private
 * database (see staging-guard.ts), so it cannot touch production even if invoked there.
 *
 *   node apps/api/dist/cli/wallet-staging.cli.js <command> [--member a|b|c] [--state active|expired]
 *
 *   seed            create (or reuse) ONE synthetic studio, plan and two synthetic members, then
 *                   issue each a wallet credential and a STATIC Apple pass through the normal
 *                   WalletPassService path. Member A is for the fresh dynamic install; member B
 *                   for the static -> dynamic replacement. Refuses a database holding anything
 *                   else. Never prints a QR value.
 *   set-entitlement the controlled staging-only change for the update test: moves the member's
 *                   synthetic cash period to "active" (current) or "expired" (ended yesterday,
 *                   stored status still ACTIVE — the October 2026 shape).
 *   export          writes the member's stored .pkpass to stdout as base64 between BEGIN/END
 *                   marker lines (everything else goes to stderr), for AirDrop to the test phone.
 *   status          per member: credential id (= pass serial), pass mode/version, timestamps, a
 *                   12-hex QR fingerprint, and registrations as {device hash, push-token length,
 *                   timestamps}. Never prints a device id, push token, auth token or QR value.
 *
 * Stage 4B (member C only — A and B are never touched; seed never creates C):
 *   prepare-first-issue --member c
 *                   create C's synthetic user, studio membership and subscription in the seeded
 *                   studio, with NO wallet credential; print C's user id, the studio id and the
 *                   exact allowlist for C only, already checked by the API's own boot validator
 *                   and eligibility policy (cap 1, no wildcard, no other user admitted).
 *   issue-first --member c
 *                   C's FIRST credential through the production first-issuance path
 *                   (WalletPassService.getBarcode). Refuses unless the LIVE allowlist is exactly C
 *                   (cap 1, synthetic studio, dynamic + routes on, refresh worker off) and C has no
 *                   credential yet; then proves C is DYNAMIC with no registration and every
 *                   pre-existing pass artifact is byte-identical. Sends no push.
 *
 * Exit codes: 0 done, 2 refused by a guard (nothing written), 1 failure.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv, ignoreEnvFile: true }),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 10_000, setHeaders: false }]),
    PrismaModule,
    WalletModule,
  ],
})
class WalletStagingCliModule {}

async function main(): Promise<number> {
  const guard = checkSmartWalletStagingTarget(process.env);
  if (!guard.ok) {
    out('refused', { reason: guard.reason });
    return 2;
  }
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || !['seed', 'set-entitlement', 'export', 'status', 'prepare-first-issue', 'issue-first'].includes(command)) {
    out('usage', { usage: 'wallet-staging.cli <seed|set-entitlement|export|status|prepare-first-issue|issue-first> [--member a|b|c] [--state active|expired]' });
    return 1;
  }

  const app = await NestFactory.createApplicationContext(WalletStagingCliModule, { logger: ['warn', 'error'] });
  try {
    const prisma = app.get(PrismaService);
    if (command === 'seed') await seed(prisma, app.get(WalletPassService), app.get(AppleWalletProvider));
    else if (command === 'set-entitlement') await setEntitlement(prisma, memberLabel(args), arg(args, '--state'));
    else if (command === 'export') await exportPass(prisma, memberLabel(args));
    else if (command === 'prepare-first-issue') await prepareFirstIssue(prisma, firstIssueLabel(args));
    else if (command === 'issue-first')
      await issueFirst(prisma, app.get(WalletPassService), app.get(AppleWalletProvider), app.get(ConfigService), firstIssueLabel(args));
    else await status(prisma);
    return 0;
  } catch (err) {
    if (err instanceof Refusal) {
      out('refused', { reason: err.message });
      return 2;
    }
    throw err;
  } finally {
    await app.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`${JSON.stringify({ event: 'wallet_staging_failed', error: err instanceof Error ? err.message : String(err) })}\n`);
    process.exitCode = 1;
  });
