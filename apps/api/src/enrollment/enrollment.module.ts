import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { StripeModule } from '../stripe/stripe.module';
import { EnrollmentAdminController } from './enrollment-admin.controller';
import { EnrollmentService } from './enrollment.service';

@Module({
  imports: [PrismaModule, StripeModule, AuthModule],
  controllers: [EnrollmentAdminController],
  providers: [EnrollmentService],
  exports: [EnrollmentService],
})
export class EnrollmentModule {}
