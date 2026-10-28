import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SalesModule } from '../sales/sales.module';
import { CommunicationsController, EmailUnsubscribeController } from './communications.controller';
import { CommunicationsService } from './communications.service';

@Module({
  imports: [PrismaModule, AuthModule, EmailModule, SalesModule],
  controllers: [CommunicationsController, EmailUnsubscribeController],
  providers: [CommunicationsService],
  exports: [CommunicationsService],
})
export class CommunicationsModule {}
