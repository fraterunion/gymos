import { Controller, Get, Param } from '@nestjs/common';
import { BrandingService } from './branding.service';

@Controller('public/studios')
export class PublicBrandingController {
  constructor(private readonly brandingService: BrandingService) {}

  @Get(':slug/branding')
  getBySlug(@Param('slug') slug: string) {
    return this.brandingService.getPublicBrandingBySlug(slug);
  }
}
