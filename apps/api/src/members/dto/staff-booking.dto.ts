import { IsString } from 'class-validator';

export class StaffBookingDto {
  @IsString()
  scheduledClassId!: string;
}
