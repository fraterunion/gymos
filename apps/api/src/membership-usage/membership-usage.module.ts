import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MembershipUsageService } from './membership-usage.service';

@Module({
  imports: [PrismaModule],
  providers: [MembershipUsageService],
  exports: [MembershipUsageService],
})
export class MembershipUsageModule {}
