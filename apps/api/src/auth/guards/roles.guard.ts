import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ROLES_KEY } from '../constants';
import type { RequestWithUser } from '../interfaces/request-with-user.interface';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles?.length) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;
    if (!user?.sub) {
      throw new UnauthorizedException();
    }
    const studioId = request.params['studioId'];
    if (!studioId || typeof studioId !== 'string') {
      throw new ForbiddenException('studioId route parameter is required');
    }

    const membership = await this.prisma.studioMembership.findUnique({
      where: { userId_studioId: { userId: user.sub, studioId } },
    });
    if (!membership || membership.deletedAt) {
      throw new ForbiddenException();
    }
    if (!roles.includes(membership.role)) {
      throw new ForbiddenException('Insufficient role');
    }
    return true;
  }
}
