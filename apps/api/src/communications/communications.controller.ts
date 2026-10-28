import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import type { RequestWithUser } from '../auth/interfaces/request-with-user.interface';
import { CommunicationsService } from './communications.service';
import { ConfirmCampaignDto, CreateCampaignDto, PreviewCampaignDto } from './dto/campaign.dto';

@Controller('studios/:studioId/communications')
@UseGuards(JwtAuthGuard, StudioMemberGuard, RolesGuard)
@Roles(Role.OWNER, Role.ADMIN)
export class CommunicationsController {
  constructor(private readonly communications: CommunicationsService) {}

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  preview(
    @Param('studioId') studioId: string,
    @Body() dto: PreviewCampaignDto,
  ) {
    return this.communications.preview(studioId, dto);
  }

  @Get('campaigns')
  list(@Param('studioId') studioId: string) {
    return this.communications.list(studioId);
  }

  @Post('campaigns')
  @HttpCode(HttpStatus.CREATED)
  create(
    @Param('studioId') studioId: string,
    @Body() dto: CreateCampaignDto,
    @Req() req: RequestWithUser,
  ) {
    return this.communications.create(studioId, req.user.sub, dto);
  }

  @Get('campaigns/:campaignId')
  getOne(@Param('studioId') studioId: string, @Param('campaignId') campaignId: string) {
    return this.communications.getOne(studioId, campaignId);
  }

  @Post('campaigns/:campaignId/confirm')
  @HttpCode(HttpStatus.OK)
  confirm(
    @Param('studioId') studioId: string,
    @Param('campaignId') campaignId: string,
    @Body() dto: ConfirmCampaignDto,
    @Req() req: RequestWithUser,
  ) {
    return this.communications.confirm(studioId, campaignId, req.user.sub, dto);
  }

  @Post('campaigns/:campaignId/retry')
  @HttpCode(HttpStatus.OK)
  retry(
    @Param('studioId') studioId: string,
    @Param('campaignId') campaignId: string,
    @Body() dto: ConfirmCampaignDto,
    @Req() req: RequestWithUser,
  ) {
    return this.communications.retryFailed(studioId, campaignId, req.user.sub, dto.confirm);
  }
}

@Controller('email')
export class EmailUnsubscribeController {
  constructor(private readonly communications: CommunicationsService) {}

  @Get('unsubscribe')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async unsubscribeGet(@Query('token') token: string, @Res() res: Response) {
    await this.communications.unsubscribe(token ?? '');
    res.status(200).send(
      '<!doctype html><meta charset="utf-8"><title>Suscripción cancelada</title><body style="font-family:sans-serif;padding:40px;"><p>Listo. No recibirás más comunicados de este estudio.</p></body>',
    );
  }

  @Post('unsubscribe')
  @HttpCode(HttpStatus.OK)
  unsubscribePost(@Query('token') queryToken: string, @Body() body: { token?: string }) {
    return this.communications.unsubscribe(body?.token || queryToken || '');
  }
}
