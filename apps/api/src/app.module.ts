import { Module, type ExecutionContext } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { validateEnv } from './config/validate-env';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { BookingsModule } from './bookings/bookings.module';
import { BrandingModule } from './branding/branding.module';
import { CheckInsModule } from './check-ins/check-ins.module';
import { ClassTemplatesModule } from './class-templates/class-templates.module';
import { MembersModule } from './members/members.module';
import { MembershipPlansModule } from './membership-plans/membership-plans.module';
import { PrismaModule } from './prisma/prisma.module';
import { ScheduleModule } from './schedule/schedule.module';
import { StudiosModule } from './studios/studios.module';
import { WaitlistModule } from './waitlist/waitlist.module';

function skipThrottleInE2eExceptAuth(context: ExecutionContext): boolean {
  if (process.env['GYMOS_E2E'] !== '1') {
    return false;
  }
  const req = context.switchToHttp().getRequest<{ url?: string; originalUrl?: string }>();
  const url = req.originalUrl ?? req.url ?? '';
  return !url.includes('/auth/');
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      envFilePath: ['.env'],
    }),
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60_000,
        limit: 10_000,
        setHeaders: false,
        skipIf: skipThrottleInE2eExceptAuth,
      },
    ]),
    PrismaModule,
    AuthModule,
    BillingModule,
    BrandingModule,
    StudiosModule,
    MembershipPlansModule,
    MembersModule,
    ClassTemplatesModule,
    ScheduleModule,
    WaitlistModule,
    BookingsModule,
    CheckInsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
