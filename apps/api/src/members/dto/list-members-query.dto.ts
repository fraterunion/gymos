import { Role, SubscriptionSource } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class ListMembersQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @IsOptional()
  @IsIn(['ACTIVE', 'TRIALING', 'ENDING', 'EXPIRED', 'PAST_DUE', 'PAUSED', 'CANCELED', 'SCHEDULED', 'NONE'])
  lifecycleStatus?: 'ACTIVE' | 'TRIALING' | 'ENDING' | 'EXPIRED' | 'PAST_DUE' | 'PAUSED' | 'CANCELED' | 'SCHEDULED' | 'NONE';

  @IsOptional()
  @IsString()
  planId?: string;

  @IsOptional()
  @IsIn([SubscriptionSource.STRIPE, SubscriptionSource.CASH, SubscriptionSource.MANUAL, 'NONE'])
  paymentSource?: SubscriptionSource | 'NONE';

  @IsOptional()
  @IsIn(['VISITED_7D', 'VISITED_30D', 'NO_VISIT_14D', 'NO_VISIT_30D', 'NEVER_ATTENDED', 'HAS_NO_SHOWS', 'HAS_FUTURE_BOOKING', 'NO_FUTURE_BOOKING', 'ENDING_7D'])
  activity?: 'VISITED_7D' | 'VISITED_30D' | 'NO_VISIT_14D' | 'NO_VISIT_30D' | 'NEVER_ATTENDED' | 'HAS_NO_SHOWS' | 'HAS_FUTURE_BOOKING' | 'NO_FUTURE_BOOKING' | 'ENDING_7D';

  @IsOptional()
  @IsIn(['joinDate', 'lastAttendance', 'totalBookings', 'name'])
  sortBy?: 'joinDate' | 'lastAttendance' | 'totalBookings' | 'name';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir?: 'asc' | 'desc';

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => parseInt(String(value), 10))
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => parseInt(String(value), 10))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === 'true' || value === true)
  @IsBoolean()
  hasNoShows?: boolean;
}
