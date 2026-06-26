import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import { UpsertEnrollmentSettingsDto } from './dto/upsert-enrollment-settings.dto';
import { EnrollmentService } from './enrollment.service';

@Controller('studios/:studioId/enrollment')
@UseGuards(JwtAuthGuard, StudioMemberGuard, RolesGuard)
@Roles(Role.OWNER, Role.ADMIN)
export class EnrollmentAdminController {
  constructor(private readonly enrollmentService: EnrollmentService) {}

  @Get('settings')
  getSettings(@Param('studioId') studioId: string) {
    return this.enrollmentService.getEnrollmentSettings(studioId);
  }

  @Put('settings')
  @HttpCode(HttpStatus.OK)
  upsertSettings(
    @Param('studioId') studioId: string,
    @Body() dto: UpsertEnrollmentSettingsDto,
  ) {
    return this.enrollmentService.upsertEnrollmentSettings(studioId, dto);
  }

  @Get('enrollments')
  listEnrollments(
    @Param('studioId') studioId: string,
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return this.enrollmentService.listEnrollments(studioId, { page, limit });
  }

  @Patch('enrollments/:enrollmentId/waive')
  @HttpCode(HttpStatus.OK)
  waiveEnrollment(
    @Param('studioId') studioId: string,
    @Param('enrollmentId') enrollmentId: string,
  ) {
    return this.enrollmentService.adminWaiveEnrollment(studioId, enrollmentId);
  }
}
