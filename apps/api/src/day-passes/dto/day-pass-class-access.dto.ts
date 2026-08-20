import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateDayPassClassAccessDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  classTemplateId!: string;
}

export type DayPassClassAccessTemplateDto = {
  id: string;
  name: string;
  durationMinutes: number;
  isOpenGymSlot: boolean;
  active: boolean;
  allowed: boolean;
};
