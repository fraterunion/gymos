import { IsString, IsUUID } from 'class-validator';

export class ManualClassAttendanceDto {
  @IsString()
  @IsUUID()
  memberId!: string;
}
