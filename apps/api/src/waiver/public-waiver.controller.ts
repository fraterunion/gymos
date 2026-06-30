import { Controller, Get, Param } from '@nestjs/common';
import { WaiverService } from './waiver.service';

@Controller('public/studios')
export class PublicWaiverController {
  constructor(private readonly waiverService: WaiverService) {}

  @Get(':slug/waiver')
  async getActiveWaiver(@Param('slug') slug: string) {
    const waiver = await this.waiverService.getActiveWaiverBySlug(slug);
    if (!waiver) {
      return null;
    }
    return waiver;
  }
}
