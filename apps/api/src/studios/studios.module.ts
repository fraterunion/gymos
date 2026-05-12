import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { MeStudiosController } from './me-studios.controller';
import { StudiosController } from './studios.controller';
import { StudiosService } from './studios.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [StudiosController, MeStudiosController],
  providers: [StudiosService],
  exports: [StudiosService],
})
export class StudiosModule {}
