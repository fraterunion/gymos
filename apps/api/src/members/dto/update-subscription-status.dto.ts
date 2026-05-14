import { SubscriptionStatus } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class UpdateSubscriptionStatusDto {
  @IsEnum(SubscriptionStatus)
  status!: SubscriptionStatus;
}
