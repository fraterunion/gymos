import {
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ThrottlerGuard,
  getOptionsToken,
  getStorageToken,
  type ThrottlerLimitDetail,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';

/**
 * Route-scoped throttler: ThrottlerGuard expects Reflector from DI, which Nest
 * does not always bind for feature-module injectables. We supply a Reflector
 * instance here (metadata reads global Reflect.*).
 *
 * ThrottlerException extends HttpException from a different physical
 * @nestjs/common instance than @nestjs/core (pnpm layout). Nest's default
 * filter then treats throttling as an unknown error (500). We rethrow with
 * this package's HttpException so 429 is returned correctly.
 */
@Injectable()
export class AuthThrottlerGuard extends ThrottlerGuard {
  constructor(
    @Inject(getOptionsToken()) options: ThrottlerModuleOptions,
    @Inject(getStorageToken()) storage: ThrottlerStorage,
  ) {
    super(options, storage, new Reflector());
  }

  /**
   * E2E suites perform many logins; register throttle is still enforced so
   * auth.e2e-spec can assert 429 on repeated POST /auth/register.
   */
  override async canActivate(context: ExecutionContext): Promise<boolean> {
    if (process.env['GYMOS_E2E'] === '1') {
      const req = context.switchToHttp().getRequest<{
        url?: string;
        originalUrl?: string;
      }>();
      const url = req.originalUrl ?? req.url ?? '';
      if (url.includes('/auth/login') || url.includes('/auth/refresh')) {
        return true;
      }
    }
    return super.canActivate(context);
  }

  protected override async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<never> {
    const message = await this.getErrorMessage(context, detail);
    throw new HttpException(message, HttpStatus.TOO_MANY_REQUESTS);
  }
}
