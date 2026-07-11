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

/** Same Reflector workaround as AuthThrottlerGuard for feature-module DI. */
@Injectable()
export class PublicThrottlerGuard extends ThrottlerGuard {
  constructor(
    @Inject(getOptionsToken()) options: ThrottlerModuleOptions,
    @Inject(getStorageToken()) storage: ThrottlerStorage,
  ) {
    super(options, storage, new Reflector());
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    if (process.env['GYMOS_E2E'] === '1') {
      return true;
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
