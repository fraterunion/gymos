import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const StudioId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<{ params: { studioId?: string } }>();
  const studioId = request.params['studioId'];
  return studioId ?? '';
});
