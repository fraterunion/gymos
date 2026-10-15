import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { WalletPassMode, WalletPassPlatform } from '@prisma/client';
import { validateEnv } from '../config/validate-env';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { WalletDynamicPassService } from '../wallet/dynamic/wallet-dynamic-pass.service';
import { WalletRefreshQueueService } from '../wallet/refresh/wallet-refresh-queue.service';
import { WalletRefreshWorkerService } from '../wallet/refresh/wallet-refresh-worker.service';
import { WalletModule } from '../wallet/wallet.module';

/**
 * Smart Wallet 2.0 Stage 3 operator tool for the refresh queue.
 *
 *   node dist/cli/wallet-refresh.cli.js <command> [--credential <id>] [--limit <n>] [--confirm]
 *
 *   queue    read-only: jobs by status, oldest due PENDING job, dead letters of the last 24 h.
 *   enqueue  queue a MANUAL refresh for the member holding --credential (all of that member's
 *            dynamic passes in the studio). Without --confirm it only shows the target.
 *   process  claim and process due jobs once (up to --limit, default 10). Needs
 *            WALLET_DYNAMIC_PASSES_ENABLED=true and --confirm. Pushes only if WALLET_APNS_ENABLED.
 *   tick     one full worker cycle now: lease recovery, change detection, transition sweep,
 *            reconciliation of EVERY dynamic pass, retention, certificate check, then process.
 *            Needs --confirm.
 *
 * The background worker is never started here; it runs only inside the API process and only
 * with WALLET_REFRESH_WORKER_ENABLED=true. Never prints tokens, device ids or QR values.
 * Exit codes: 0 done (or dry run), 2 refused (nothing written), 1 failure.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv, envFilePath: ['.env'] }),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 10_000, setHeaders: false }]),
    PrismaModule,
    WalletModule,
  ],
})
class WalletRefreshCliModule {}

const COMMANDS = ['queue', 'enqueue', 'process', 'tick'] as const;
type Command = (typeof COMMANDS)[number];
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function print(event: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: `wallet_refresh_cli_${event}`, ...data }));
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const command = args[0] as Command | undefined;
  const walletCredentialId = flag(args, '--credential');
  const limitRaw = flag(args, '--limit');
  const limit = limitRaw === undefined ? 10 : Number(limitRaw);
  const confirm = args.includes('--confirm');
  const usage = 'wallet-refresh.cli <queue|enqueue|process|tick> [--credential <id>] [--limit <1-100>] [--confirm]';

  if (
    !command ||
    !COMMANDS.includes(command) ||
    (command === 'enqueue' && (!walletCredentialId || !ID_PATTERN.test(walletCredentialId))) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    print('usage', { usage });
    return 1;
  }

  const app = await NestFactory.createApplicationContext(WalletRefreshCliModule, { logger: ['log', 'warn', 'error'] });
  try {
    const now = new Date();
    const queue = app.get(WalletRefreshQueueService);

    if (command === 'queue') {
      print('queue', { at: now.toISOString(), ...(await queue.stats(now)) });
      return 0;
    }

    if (command === 'enqueue') {
      const artifact = await app.get(PrismaService).walletPassArtifact.findUnique({
        where: { walletCredentialId_platform: { walletCredentialId: walletCredentialId!, platform: WalletPassPlatform.APPLE } },
        select: { passMode: true, walletCredential: { select: { studioId: true, userId: true } } },
      });
      if (!artifact || artifact.passMode !== WalletPassMode.DYNAMIC) {
        print('refused', { walletCredentialId, reason: artifact ? 'NOT_DYNAMIC' : 'ARTIFACT_NOT_FOUND' });
        return 2;
      }
      const target = { studioId: artifact.walletCredential.studioId, userId: artifact.walletCredential.userId };
      if (!confirm) {
        print('dry_run', { walletCredentialId, studioId: target.studioId, wouldEnqueue: 1 });
        return 0;
      }
      print('enqueued', { walletCredentialId, studioId: target.studioId, rows: await queue.enqueue([target], 'MANUAL', { now }) });
      return 0;
    }

    if (!confirm) {
      print('refused', { reason: 'CONFIRM_REQUIRED' });
      return 2;
    }
    if (!app.get(WalletDynamicPassService).isEnabled()) {
      print('refused', { reason: 'WALLET_DYNAMIC_PASSES_DISABLED' });
      return 2;
    }
    const worker = app.get(WalletRefreshWorkerService);
    if (command === 'process') {
      print('processed', { workerId: worker.workerId, jobs: await worker.processDue(now, limit) });
      return 0;
    }
    print('tick', { ...(await worker.runOnce(now, { force: true, limit })) });
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
    console.error(JSON.stringify({ event: 'wallet_refresh_cli_failed', error: err instanceof Error ? err.message : String(err) }));
    process.exitCode = 1;
  });
