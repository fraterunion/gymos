import { Controller, Get, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from './decorators/current-user.decorator';
import { Roles } from './decorators/roles.decorator';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { StudioMemberGuard } from './guards/studio-member.guard';
import type { JwtUser } from './interfaces/jwt-user.type';

@Controller('studios')
@UseGuards(JwtAuthGuard)
export class StudioAccessController {
  @Get(':studioId/verify')
  @UseGuards(StudioMemberGuard)
  verify(@CurrentUser() user: JwtUser) {
    return { ok: true as const, sub: user.sub };
  }

  @Get(':studioId/admin-only')
  @UseGuards(StudioMemberGuard, RolesGuard)
  @Roles(Role.ADMIN)
  adminOnly() {
    return { ok: true as const };
  }
}
