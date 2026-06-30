import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { resolveSalesSettings, type SalesSettingsView } from './sales-permissions';

@Injectable()
export class SalesSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async getSettings(studioId: string): Promise<SalesSettingsView> {
    const row = await this.prisma.studioSalesSettings.findUnique({
      where: { studioId },
    });
    return resolveSalesSettings(row);
  }
}
