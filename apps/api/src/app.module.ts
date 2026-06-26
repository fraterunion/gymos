import { Module, type ExecutionContext } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule as NestSchedulerModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { validateEnv } from './config/validate-env';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { BookingsModule } from './bookings/bookings.module';
import { BrandingModule } from './branding/branding.module';
import { BuildJobsModule } from './build-jobs/build-jobs.module';
import { CheckInsModule } from './check-ins/check-ins.module';
import { DayPassesModule } from './day-passes/day-passes.module';
import { ClassTemplatesModule } from './class-templates/class-templates.module';
import { ScheduleTemplatesModule } from './schedule-templates/schedule-templates.module';
import { ScheduleGeneratorModule } from './schedule-generator/schedule-generator.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { MembersModule } from './members/members.module';
import { MembershipPlansModule } from './membership-plans/membership-plans.module';
import { MembershipsModule } from './memberships/memberships.module';
import { PrismaModule } from './prisma/prisma.module';
import { PublicDiscoveryModule } from './public-discovery/public-discovery.module';
import { ScheduleModule } from './schedule/schedule.module';
import { StaffModule } from './staff/staff.module';
import { StudioSettingsModule } from './studio-settings/studio-settings.module';
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
    NestSchedulerModule.forRoot(),
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
    AnalyticsModule,
    BillingModule,
    BrandingModule,
    PublicDiscoveryModule,
    BuildJobsModule,
    StudiosModule,
    MembershipPlansModule,
    MembershipsModule,
    MembersModule,
    StaffModule,
    ClassTemplatesModule,
    ScheduleModule,
    ScheduleTemplatesModule,
    ScheduleGeneratorModule,
    StudioSettingsModule,
    WaitlistModule,
    BookingsModule,
    CheckInsModule,
    DayPassesModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
