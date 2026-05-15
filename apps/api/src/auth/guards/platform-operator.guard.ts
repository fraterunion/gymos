import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { PlatformOperatorService } from '../platform-operator.service';
import type { RequestWithUser } from '../interfaces/request-with-user.interface';

@Injectable()
export class PlatformOperatorGuard implements CanActivate {
  constructor(private readonly platformOperatorService: PlatformOperatorService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const email = request.user?.email;
    if (!this.platformOperatorService.isOperator(email)) {
      throw new ForbiddenException('FraterUnion platform operator access required');
    }
    return true;
  }
}
