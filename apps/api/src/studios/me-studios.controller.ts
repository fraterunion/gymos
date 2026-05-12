import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StudiosService } from './studios.service';

@Controller('me')
@UseGuards(JwtAuthGuard)
export class MeStudiosController {
  constructor(private readonly studiosService: StudiosService) {}

  @Get('studios')
  listMyStudios(@CurrentUser('sub') userId: string) {
    return this.studiosService.listStudiosForUser(userId);
  }
}
