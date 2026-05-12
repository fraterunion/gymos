import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import { ClassTemplatesService } from './class-templates.service';
import { CreateClassTemplateDto } from './dto/create-class-template.dto';
import { UpdateClassTemplateDto } from './dto/update-class-template.dto';

@Controller('studios/:studioId/class-templates')
@UseGuards(JwtAuthGuard, StudioMemberGuard)
export class ClassTemplatesController {
  constructor(private readonly classTemplatesService: ClassTemplatesService) {}

  @Get()
  list(@Param('studioId') studioId: string) {
    return this.classTemplatesService.listTemplates(studioId);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  create(@Param('studioId') studioId: string, @Body() dto: CreateClassTemplateDto) {
    return this.classTemplatesService.createTemplate(studioId, dto);
  }

  @Patch(':templateId')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  update(
    @Param('studioId') studioId: string,
    @Param('templateId') templateId: string,
    @Body() dto: UpdateClassTemplateDto,
  ) {
    return this.classTemplatesService.updateTemplate(studioId, templateId, dto);
  }

  @Delete(':templateId')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('studioId') studioId: string, @Param('templateId') templateId: string) {
    await this.classTemplatesService.softDeleteTemplate(studioId, templateId);
  }
}
