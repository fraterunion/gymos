import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { DayPassesService, DayPassPaymentSheetResponse } from './day-passes.service';
import { CreateDayPassPaymentSheetDto } from './dto/create-day-pass-payment-sheet.dto';
import { ListMyDayPassesQueryDto } from './dto/list-my-day-passes.query.dto';

@Controller('studios/:studioId/day-passes')
@UseGuards(JwtAuthGuard, StudioMemberGuard)
export class DayPassesController {
  constructor(private readonly dayPassesService: DayPassesService) {}

  @Get('me')
  listMine(
    @Param('studioId') studioId: string,
    @CurrentUser('sub') userId: string,
    @Query() query: ListMyDayPassesQueryDto,
  ) {
    return this.dayPassesService.listMyDayPasses(studioId, userId, query.scope ?? 'all');
  }

  /** Studio-local today, purchase horizon and already-owned days for the date picker. */
  @Get('purchase-window')
  purchaseWindow(
    @Param('studioId') studioId: string,
    @CurrentUser('sub') userId: string,
  ) {
    return this.dayPassesService.getPurchaseWindow(studioId, userId);
  }

  /**
   * Server-verified refresh after PaymentSheet reports success. The API asks Stripe for the
   * intent's live status; the client's own claim of success is never what activates the pass.
   */
  @Post(':dayPassId/sync')
  @HttpCode(HttpStatus.OK)
  syncFromStripe(
    @Param('studioId') studioId: string,
    @Param('dayPassId') dayPassId: string,
    @CurrentUser('sub') userId: string,
  ) {
    return this.dayPassesService.syncDayPassFromStripe({ studioId, userId, dayPassId });
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
