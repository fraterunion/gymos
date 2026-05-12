import {
  IsDateString,
  IsNotEmpty,
} from 'class-validator';

export class ScheduleQueryDto {
  @IsNotEmpty()
  @IsDateString()
  from!: string;

  @IsNotEmpty()
  @IsDateString()
  to!: string;
}
