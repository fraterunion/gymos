import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { BrandingController } from './branding.controller';
import { BrandingService } from './branding.service';
import { PublicBrandingController } from './public-branding.controller';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [PublicBrandingController, BrandingController],
  providers: [BrandingService],
})
export class BrandingModule {}
