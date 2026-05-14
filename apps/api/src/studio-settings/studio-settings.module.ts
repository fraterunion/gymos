import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { StudioSettingsController } from './studio-settings.controller';
import { StudioSettingsService } from './studio-settings.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [StudioSettingsController],
  providers: [StudioSettingsService],
})
export class StudioSettingsModule {}
