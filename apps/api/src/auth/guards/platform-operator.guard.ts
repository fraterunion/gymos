import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { RequestWithUser } from '../interfaces/request-with-user.interface';

@Injectable()
export class PlatformOperatorGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    if (request.user?.platformRole !== 'PLATFORM_ADMIN') {
      throw new ForbiddenException('FraterUnion platform operator access required');
    }
    return true;
  }
}
