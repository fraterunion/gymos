import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AppleWalletProvider } from './apple/apple-wallet-provider.service';
import { GoogleWalletProvider } from './google/google-wallet-provider.service';
import { WalletAccessSnapshotLoader } from './access/wallet-access-snapshot.loader';
import { WalletCredentialService } from './wallet-credential.service';
import { WalletPassBrandingResolver } from './wallet-pass-branding.resolver';
import { WalletPassController } from './wallet-pass.controller';
import { WalletPassService } from './wallet-pass.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [WalletPassController],
  providers: [
    WalletCredentialService,
    WalletPassBrandingResolver,
    AppleWalletProvider,
    GoogleWalletProvider,
    WalletAccessSnapshotLoader,
    WalletPassService,
  ],
  exports: [WalletCredentialService],
})
export class WalletModule {}
