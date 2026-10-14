import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PublicThrottlerGuard } from '../public-discovery/public-throttler.guard';
import { AppleWalletProvider } from './apple/apple-wallet-provider.service';
import { GoogleWalletProvider } from './google/google-wallet-provider.service';
import { WalletAccessSnapshotLoader } from './access/wallet-access-snapshot.loader';
import { WalletDynamicPassService } from './dynamic/wallet-dynamic-pass.service';
import { PasskitController, PasskitRoutesEnabledGuard } from './passkit/passkit.controller';
import { PasskitService } from './passkit/passkit.service';
import { WalletPassPushService } from './passkit/wallet-pass-push.service';
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
    PasskitService,
    PasskitRoutesEnabledGuard,
    PublicThrottlerGuard,
  ],
  exports: [WalletCredentialService, WalletDynamicPassService, WalletPassPushService],
})
export class WalletModule {}
