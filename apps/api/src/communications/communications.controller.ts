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
import type { Request, Response } from 'express';
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

  /** Delivery paused/active and the exact From / Reply-To campaigns will use. */
  @Get('status')
  status(@Param('studioId') studioId: string) {
    return this.communications.status(studioId);
  }

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

  /**
   * Browser-friendly unsubscribe page. The GET is intentionally read-only:
   * email security scanners must not unsubscribe a real member merely by
   * following a link embedded in a message.
   */
  @Get('unsubscribe')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('Content-Security-Policy', "default-src 'none'; form-action 'self'; style-src 'unsafe-inline'; base-uri 'none'")
  unsubscribeGet(@Query('token') token: string, @Res() res: Response) {
    this.communications.validateUnsubscribeToken(token ?? '');
    const action = `/api/v1/email/unsubscribe?token=${encodeURIComponent(token)}`;
    res.status(200).send(
      `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cancelar comunicaciones</title></head><body style="font-family:system-ui,sans-serif;max-width:520px;margin:80px auto;padding:24px;color:#171717"><h1>Cancelar comunicaciones</h1><p>¿Quieres dejar de recibir correos informativos de este estudio?</p><form method="POST" action="${action}"><button type="submit" style="background:#171717;color:#fff;border:0;border-radius:8px;padding:14px 20px;cursor:pointer">Confirmar baja</button></form><p style="color:#666;font-size:14px">Los correos transaccionales necesarios para tu membresía no se verán afectados.</p></body></html>`,
    );
  }

  /** RFC 8058 List-Unsubscribe-Post and explicit browser confirmation. */
  @Post('unsubscribe')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async unsubscribePost(
    @Query('token') queryToken: string,
    @Body() body: { token?: string } | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const result = await this.communications.unsubscribe(body?.token || queryToken || '');
    if (req.headers.accept?.includes('text/html')) {
      res.status(200).type('html').send(
        '<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Baja confirmada</title></head><body style="font-family:system-ui,sans-serif;max-width:520px;margin:80px auto;padding:24px;color:#171717"><h1>Baja confirmada</h1><p>Listo. Ya no recibirás comunicaciones informativas de este estudio.</p><p>Las notificaciones transaccionales de tu membresía seguirán funcionando.</p></body></html>',
      );
      return;
    }
    res.status(200).json(result);
  }
}
