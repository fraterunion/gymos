import { IsBoolean } from 'class-validator';

export class SetCancelAtPeriodEndDto {
  @IsBoolean()
  cancel!: boolean;
}
