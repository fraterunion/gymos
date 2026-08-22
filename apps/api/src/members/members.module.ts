import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { CheckInsModule } from '../check-ins/check-ins.module';
import { MembershipUsageModule } from '../membership-usage/membership-usage.module';
import { PrismaModule } from '../prisma/prisma.module';
import { StripeModule } from '../stripe/stripe.module';
import { WaitlistModule } from '../waitlist/waitlist.module';
import { MembersController } from './members.controller';
import { MemberOperationalNotesService } from './member-operational-notes.service';
import { MembersService } from './members.service';
import { ProgressService } from './progress.service';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    WaitlistModule,
    StripeModule,
    MembershipUsageModule,
    BillingModule,
    CheckInsModule,
  ],
  controllers: [MembersController],
  providers: [MembersService, MemberOperationalNotesService, ProgressService],
})
export class MembersModule {}
