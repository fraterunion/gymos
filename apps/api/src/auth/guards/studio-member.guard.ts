import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { RequestWithUser } from '../interfaces/request-with-user.interface';

@Injectable()
export class StudioMemberGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;
    if (!user?.sub) {
      throw new UnauthorizedException();
    }
    const studioId = request.params['studioId'];
    if (!studioId || typeof studioId !== 'string') {
      throw new ForbiddenException('studioId route parameter is required');
    }

    const [dbUser, membership] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: user.sub } }),
      this.prisma.studioMembership.findUnique({
        where: { userId_studioId: { userId: user.sub, studioId } },
      }),
    ]);

    if (!dbUser || dbUser.deletedAt) {
      throw new ForbiddenException();
    }
    if (!membership || membership.deletedAt) {
      throw new ForbiddenException('Not a member of this studio');
    }

    return true;
  }
}
