import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PublicThrottlerGuard } from '../public-discovery/public-throttler.guard';
import { AppleWalletProvider } from './apple/apple-wallet-provider.service';
import { GoogleWalletProvider } from './google/google-wallet-provider.service';
import { WalletAccessSnapshotLoader } from './access/wallet-access-snapshot.loader';
import { WalletDynamicPassService } from './dynamic/wallet-dynamic-pass.service';
import { PasskitController, PasskitRoutesEnabledGuard } from './passkit/passkit.controller';
import { ApnsClientFactory } from './passkit/apns.client';
import { PasskitService } from './passkit/passkit.service';
import { WalletPassEventsService } from './passkit/wallet-pass-events.service';
import { WalletPassPushService } from './passkit/wallet-pass-push.service';
import { WalletDiagnosticsService } from './refresh/wallet-diagnostics.service';
import { WalletHealthService } from './refresh/wallet-health.service';
import { WalletRefreshProcessorService } from './refresh/wallet-refresh-processor.service';
import { WalletRefreshQueueService } from './refresh/wallet-refresh-queue.service';
import { WalletRefreshTriggersService } from './refresh/wallet-refresh-triggers.service';
import { WalletRefreshWorkerService } from './refresh/wallet-refresh-worker.service';
import { WalletCredentialService } from './wallet-credential.service';
import { WalletPassBrandingResolver } from './wallet-pass-branding.resolver';
import { WalletPassController } from './wallet-pass.controller';
import { WalletPassService } from './wallet-pass.service';

@Module({
  imports: [PrismaModule, AuthModule],
  // PasskitController answers 404 on every route unless WALLET_PASSKIT_ROUTES_ENABLED=true.
  controllers: [WalletPassController, PasskitController],
  providers: [
    WalletCredentialService,
    WalletPassBrandingResolver,
    AppleWalletProvider,
    GoogleWalletProvider,
    WalletAccessSnapshotLoader,
    WalletPassService,
    WalletDynamicPassService,
    WalletPassPushService,
    ApnsClientFactory,
    WalletPassEventsService,
    PasskitService,
    PasskitRoutesEnabledGuard,
    PublicThrottlerGuard,
    WalletRefreshQueueService,
    WalletRefreshTriggersService,
    WalletRefreshProcessorService,
    WalletRefreshWorkerService,
    WalletDiagnosticsService,
    WalletHealthService,
  ],
  exports: [
    WalletCredentialService,
    WalletDynamicPassService,
    WalletPassPushService,
    WalletRefreshWorkerService,
    WalletRefreshQueueService,
    WalletDiagnosticsService,
    WalletHealthService,
  ],
})
export class WalletModule {}
