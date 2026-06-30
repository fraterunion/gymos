import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import { AcceptWaiverDto, WaiverAttestationDto } from './dto/waiver.dto';
import { extractRequestClientMeta } from './request-client-meta';
import { WaiverService } from './waiver.service';

@Controller('studios/:studioId')
@UseGuards(JwtAuthGuard, StudioMemberGuard)
export class WaiverController {
  constructor(private readonly waiverService: WaiverService) {}

  @Get('me/waiver-status')
  getMyWaiverStatus(
    @Param('studioId') studioId: string,
    @CurrentUser('sub') userId: string,
  ) {
    return this.waiverService.getWaiverStatus(studioId, userId);
  }

  @Post('me/waiver-acceptance')
  @HttpCode(HttpStatus.CREATED)
  acceptWaiver(
    @Param('studioId') studioId: string,
    @CurrentUser('sub') userId: string,
    @Body() dto: AcceptWaiverDto,
    @Req() req: Request,
  ) {
    if (!dto.accepted) {
      throw new BadRequestException('Debes aceptar la Carta Responsiva para continuar.');
    }
    const meta = extractRequestClientMeta(req);
    return this.waiverService.createSelfAcceptance({
      studioId,
      userId,
      waiverDocumentId: dto.waiverDocumentId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }

  @Get('members/:userId/waiver-status')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN, Role.STAFF, Role.FRONT_DESK)
  getMemberWaiverStatus(
    @Param('studioId') studioId: string,
    @Param('userId') userId: string,
  ) {
    return this.waiverService.getMemberWaiverStatus(studioId, userId);
  }

  @Post('members/:userId/waiver-attestation')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN, Role.FRONT_DESK)
  @HttpCode(HttpStatus.CREATED)
  attestMemberWaiver(
    @Param('studioId') studioId: string,
    @Param('userId') userId: string,
    @CurrentUser('sub') actorUserId: string,
    @Body() dto: WaiverAttestationDto,
  ) {
    return this.waiverService.createStaffAttestation({
      studioId,
      targetUserId: userId,
      actorUserId,
      waiverDocumentId: dto.waiverDocumentId,
      attestationNote: dto.attestationNote,
    });
  }
}
