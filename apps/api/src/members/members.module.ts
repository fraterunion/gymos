import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { StripeModule } from '../stripe/stripe.module';
import { WaitlistModule } from '../waitlist/waitlist.module';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';

@Module({
  imports: [PrismaModule, AuthModule, WaitlistModule, StripeModule],
  controllers: [MembersController],
  providers: [MembersService],
})
export class MembersModule {}
