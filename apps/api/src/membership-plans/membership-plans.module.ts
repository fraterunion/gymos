import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { PrismaModule } from '../prisma/prisma.module';
import { MembershipPlansController } from './membership-plans.controller';
import { MembershipPlansService } from './membership-plans.service';

@Module({
  imports: [PrismaModule, AuthModule, BillingModule],
  controllers: [MembershipPlansController],
  providers: [MembershipPlansService],
})
export class MembershipPlansModule {}
