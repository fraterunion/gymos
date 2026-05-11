import { INestApplicationContext, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Prisma 5+ library engine does not support `$on('beforeExit')` (binary engine only).
   * Pair with `app.enableShutdownHooks()` in `main.ts`; Nest shutdown runs `onModuleDestroy`, which disconnects Prisma.
   */
  enableShutdownHooks(_app: INestApplicationContext): void {
    void _app;
  }
}
