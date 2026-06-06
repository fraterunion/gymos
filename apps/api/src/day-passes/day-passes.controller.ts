import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { DayPassesService, DayPassPaymentSheetResponse } from './day-passes.service';
import { CreateDayPassPaymentSheetDto } from './dto/create-day-pass-payment-sheet.dto';

@Controller('studios/:studioId/day-passes')
@UseGuards(JwtAuthGuard, StudioMemberGuard)
export class DayPassesController {
  constructor(private readonly dayPassesService: DayPassesService) {}

  @Get('me')
  listMine(
    @Param('studioId') studioId: string,
    @CurrentUser('sub') userId: string,
  ) {
    return this.dayPassesService.listMyDayPasses(studioId, userId);
  }

  @Post('payment-sheet')
  @HttpCode(HttpStatus.CREATED)
  createPaymentSheet(
    @Param('studioId') studioId: string,
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateDayPassPaymentSheetDto,
  ): Promise<DayPassPaymentSheetResponse> {
    return this.dayPassesService.createDayPassPaymentSheet({
      studioId,
      userId,
      validForDate: dto.validForDate,
    });
  }
}
