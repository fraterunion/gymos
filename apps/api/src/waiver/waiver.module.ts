import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PublicWaiverController } from './public-waiver.controller';
import { WaiverController } from './waiver.controller';
import { WaiverService } from './waiver.service';

@Module({
  imports: [PrismaModule, forwardRef(() => AuthModule)],
  controllers: [PublicWaiverController, WaiverController],
  providers: [WaiverService],
  exports: [WaiverService],
})
export class WaiverModule {}
