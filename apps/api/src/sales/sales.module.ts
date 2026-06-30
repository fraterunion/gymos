import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { PrismaModule } from '../prisma/prisma.module';
import { WaiverModule } from '../waiver/waiver.module';
import { AuditService } from './audit.service';
import { SalesMembersController, SalesController } from './sales.controller';
import { SalesSettingsService } from './sales-settings.service';
import { SalesService } from './sales.service';

@Module({
  imports: [PrismaModule, AuthModule, BillingModule, WaiverModule],
  controllers: [SalesController, SalesMembersController],
  providers: [SalesService, AuditService, SalesSettingsService],
  exports: [SalesService, AuditService, SalesSettingsService],
})
export class SalesModule {}
