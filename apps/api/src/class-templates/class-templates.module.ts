import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SalesModule } from '../sales/sales.module';
import { ClassTemplatesController } from './class-templates.controller';
import { ClassTemplatesService } from './class-templates.service';

@Module({
  imports: [PrismaModule, AuthModule, SalesModule],
  controllers: [ClassTemplatesController],
  providers: [ClassTemplatesService],
})
export class ClassTemplatesModule {}
