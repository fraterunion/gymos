import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { WalletPassPlatform } from '@prisma/client';
import { validateEnv } from '../config/validate-env';
import { extractBarcodeMessageFromPkpass } from '../wallet/apple/pkpass-reader';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { WalletDynamicPassError, WalletDynamicPassService } from '../wallet/dynamic/wallet-dynamic-pass.service';
import { WalletPassPushError, WalletPassPushService } from '../wallet/passkit/wallet-pass-push.service';
import { WalletModule } from '../wallet/wallet.module';

/**
 * Smart Wallet 2.0 Stage 1A operator tool — ONE wallet credential per invocation, never a batch.
 *
 *   node dist/cli/wallet-dynamic-pass.cli.js <command> --credential <walletCredentialId> [--confirm] [--push]
 *
 *   preview  read-only: the state and fields the dynamic pass would show now (no member name,
 *            no barcode, no token is printed). Needs no flag.
 *   status   read-only: artifact mode, versions, timestamps, registration count, and a short
 *            SHA-256 fingerprint of the stored pass's QR value (never the value itself) so a
 *            before/after comparison can prove the QR did not change.
 *   enroll   STATIC -> DYNAMIC for this credential's Apple pass (same serial, same QR, a new
 *            per-pass token). Needs WALLET_DYNAMIC_PASSES_ENABLED=true and --confirm;
 *            without --confirm it only previews.
 *   refresh  recompute a DYNAMIC pass; re-sign only if its content changed. Needs the flag and
 *            --confirm. With --push (and WALLET_APNS_ENABLED=true) a CHANGED pass is pushed.
 *   push     send the APNs update notification for a DYNAMIC pass. Needs WALLET_APNS_ENABLED
 *            and --confirm.
 *
 * Exit codes: 0 done (or dry run), 2 refused by a safety rule (nothing written), 1 failure.
 * Not AppModule: no HTTP server, no schedulers, no workers.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv, envFilePath: ['.env'] }),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 10_000, setHeaders: false }]),
    PrismaModule,
    WalletModule,
  ],
})
class WalletDynamicPassCliModule {}

const COMMANDS = ['preview', 'status', 'enroll', 'refresh', 'push'] as const;
type Command = (typeof COMMANDS)[number];
const CREDENTIAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function print(event: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: `wallet_dynamic_cli_${event}`, ...data }));
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const command = args[0] as Command | undefined;
  const credentialFlag = args.indexOf('--credential');
  const walletCredentialId = credentialFlag >= 0 ? args[credentialFlag + 1] : undefined;
  const confirm = args.includes('--confirm');
  const push = args.includes('--push');

  if (!command || !COMMANDS.includes(command) || !walletCredentialId || !CREDENTIAL_ID_PATTERN.test(walletCredentialId)) {
    print('usage', { usage: 'wallet-dynamic-pass.cli <preview|status|enroll|refresh|push> --credential <id> [--confirm] [--push]' });
    return 1;
  }

  const app = await NestFactory.createApplicationContext(WalletDynamicPassCliModule, { logger: ['log', 'warn', 'error'] });
  try {
    const dynamic = app.get(WalletDynamicPassService);
    const pushes = app.get(WalletPassPushService);

    if (command === 'status') {
      const artifact = await app.get(PrismaService).walletPassArtifact.findUnique({
        where: { walletCredentialId_platform: { walletCredentialId, platform: WalletPassPlatform.APPLE } },
        select: {
          pkpassData: true,
          passMode: true,
          templateVersion: true,
          dynamicTemplateVersion: true,
          passVersion: true,
          lastModifiedAt: true,
          nextTransitionAt: true,
          dynamicEnabledAt: true,
          _count: { select: { registrations: true } },
        },
      });
      if (!artifact) {
        print('status', { walletCredentialId, found: false });
        return 0;
      }
      const { pkpassData, ...fields } = artifact;
      let qrFingerprint: string | null = null;
      if (pkpassData) {
        try {
          const message = await extractBarcodeMessageFromPkpass(Buffer.from(pkpassData));
          qrFingerprint = createHash('sha256').update(message).digest('hex').slice(0, 12);
        } catch {
          qrFingerprint = 'unreadable';
        }
      }
      print('status', { walletCredentialId, found: true, ...fields, qrFingerprint });
      return 0;
    }

    if (command === 'preview' || ((command === 'enroll' || command === 'refresh') && !confirm)) {
      const p = await dynamic.preview(walletCredentialId);
      print('preview', {
        walletCredentialId,
        dryRun: command !== 'preview',
        passMode: p.passMode,
        overall: p.snapshot.overall,
        nextTransitionAt: p.snapshot.nextTransitionAt,
        memberships: p.snapshot.memberships.map((m) => ({
          plan: m.planName,
          lifecycleStatus: m.lifecycleStatus,
          isEntitled: m.isEntitled,
          isPrimary: m.isPrimary,
          effectiveEnd: m.effectiveEnd,
        })),
        dayPasses: p.snapshot.dayPasses.map((d) => ({ dateKey: d.dateKey, relative: d.relative })),
        fields: {
          status: p.display.status.value,
          plan: p.display.plan?.value ?? null,
          validity: p.display.validity?.value ?? null,
          scope: p.display.scope?.value ?? null,
          details: p.display.details.map((d) => `${d.label}: ${d.value}`),
          voided: p.display.voided,
        },
      });
      return 0;
    }

    if (!confirm) {
      print('refused', { walletCredentialId, reason: 'CONFIRM_REQUIRED' });
      return 2;
    }

    if (command === 'enroll') {
      print('result', { ...(await dynamic.enroll(walletCredentialId)) });
      return 0;
    }
    if (command === 'refresh') {
      const result = await dynamic.refresh(walletCredentialId);
      print('result', { ...result });
      if (push && result.outcome === 'updated') {
        print('push', { ...(await pushes.pushPassUpdate(walletCredentialId)) });
      }
      return 0;
    }
    print('push', { ...(await pushes.pushPassUpdate(walletCredentialId)) });
    return 0;
  } catch (err) {
    if (err instanceof WalletDynamicPassError || err instanceof WalletPassPushError) {
      print('refused', { walletCredentialId, reason: err.code });
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
    console.error(JSON.stringify({ event: 'wallet_dynamic_cli_failed', error: err instanceof Error ? err.message : String(err) }));
    process.exitCode = 1;
  });
