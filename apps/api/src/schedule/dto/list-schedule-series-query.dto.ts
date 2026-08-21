import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class ListScheduleSeriesQueryDto {
  @IsOptional()
  @IsIn(['all', 'active', 'ended'])
  status?: 'all' | 'active' | 'ended';

  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  instructorId?: string;
}
